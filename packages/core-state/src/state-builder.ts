import { Repositories } from "@arkecosystem/core-database";
import { Application, Container, Contracts, Enums, Utils as AppUtils } from "@arkecosystem/core-kernel";
import { Handlers } from "@arkecosystem/core-transactions";
import { Managers, Utils } from "@arkecosystem/crypto";

import { WalletRepository, WalletState } from "./wallets";

// todo: review the implementation
@Container.injectable()
export class StateBuilder {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Application;

    @Container.inject(Container.Identifiers.BlockRepository)
    private blockRepository!: Repositories.BlockRepository;

    @Container.inject(Container.Identifiers.TransactionRepository)
    private transactionRepository!: Repositories.TransactionRepository;

    @Container.inject(Container.Identifiers.WalletRepository)
    private walletRepository!: WalletRepository;

    @Container.inject(Container.Identifiers.WalletState)
    private walletState!: WalletState;

    @Container.inject(Container.Identifiers.LogService)
    private logger!: Contracts.Kernel.Log.Logger;

    @Container.inject(Container.Identifiers.EventDispatcherService)
    private emitter!: Contracts.Kernel.Events.EventDispatcher;

    public async run(): Promise<void> {
        this.logger = this.app.log;
        this.emitter = this.app.get<Contracts.Kernel.Events.EventDispatcher>(
            Container.Identifiers.EventDispatcherService,
        );
        const transactionHandlers: Handlers.TransactionHandler[] = this.app
            .get<Handlers.Registry>(Container.Identifiers.TransactionHandlerRegistry)
            .getAll();
        const steps = transactionHandlers.length + 3;

        try {
            this.logger.info(`State Generation - Step 1 of ${steps}: Block Rewards`);
            await this.buildBlockRewards();

            this.logger.info(`State Generation - Step 2 of ${steps}: Fees & Nonces`);
            await this.buildSentTransactions();

            const capitalize = (key: string) => key[0].toUpperCase() + key.slice(1);
            for (let i = 0; i < transactionHandlers.length; i++) {
                const transactionHandler = transactionHandlers[i];

                const constructoKey: string | undefined = transactionHandler.getConstructor().key;

                AppUtils.assert.defined<string>(constructoKey);

                this.logger.info(`State Generation - Step ${3 + i} of ${steps}: ${capitalize(constructoKey)}`);

                await transactionHandler.bootstrap();
            }

            this.logger.info(`State Generation - Step ${steps} of ${steps}: Vote Balances & Delegate Ranking`);
            this.walletState.buildVoteBalances();
            this.walletState.buildDelegateRanking();

            this.logger.info(
                `Number of registered delegates: ${Object.keys(this.walletRepository.allByUsername()).length}`,
            );

            this.verifyWalletsConsistency();

            this.emitter.dispatch(Enums.InternalEvent.StateBuilderFinished);
        } catch (ex) {
            this.logger.error(ex.stack);
        }
    }

    private async buildBlockRewards(): Promise<void> {
        const blocks = await this.blockRepository.getBlockRewards();

        for (const block of blocks) {
            const wallet = this.walletRepository.findByPublicKey(block.generatorPublicKey);
            wallet.balance = wallet.balance.plus(block.rewards);
        }
    }

    private async buildSentTransactions(): Promise<void> {
        const transactions = await this.transactionRepository.getSentTransactions();

        for (const transaction of transactions) {
            const wallet = this.walletRepository.findByPublicKey(transaction.senderPublicKey);
            wallet.nonce = Utils.BigNumber.make(transaction.nonce);
            wallet.balance = wallet.balance.minus(transaction.amount).minus(transaction.fee);
        }
    }

    private verifyWalletsConsistency(): void {
        const genesisPublicKeys: Record<string, true> = Managers.configManager
            .get("genesisBlock.transactions")
            .reduce((acc, curr) => Object.assign(acc, { [curr.senderPublicKey]: true }), {});

        for (const wallet of this.walletRepository.allByAddress()) {
            if (wallet.balance.isLessThan(0) && (wallet.publicKey === undefined || !genesisPublicKeys[wallet.publicKey])) {
                // Senders of whitelisted transactions that result in a negative balance,
                // also need to be special treated during bootstrap. Therefore, specific
                // senderPublicKey/nonce pairs are allowed to be negative.
                // Example:
                //          https://explorer.ark.io/transaction/608c7aeba0895da4517496590896eb325a0b5d367e1b186b1c07d7651a568b9e
                //          Results in a negative balance (-2 ARK) from height 93478 to 187315
                const negativeBalanceExceptions: Record<string, Record<string, string>> | undefined = this.app.config(
                    "exceptions.negativeBalances",
                    {},
                );

                AppUtils.assert.defined<Record<string, Record<string, string>>>(negativeBalanceExceptions);

                const negativeBalances: Record<string, string> | undefined = wallet.publicKey ? negativeBalanceExceptions[wallet.publicKey] : undefined;
                if (negativeBalances && !wallet.balance.isEqualTo(negativeBalances[wallet.nonce.toString()] || 0)) {
                    this.logger.warning(`Wallet '${wallet.address}' has a negative balance of '${wallet.balance}'`);
                    throw new Error("Non-genesis wallet with negative balance.");
                }
            }

            if (wallet.hasAttribute("delegate.voteBalance")) {
                const voteBalance: Utils.BigNumber = wallet.getAttribute("delegate.voteBalance");
                if (voteBalance.isLessThan(0)) {
                    this.logger.warning(`Wallet ${wallet.address} has a negative vote balance of '${voteBalance}'`);

                    throw new Error("Wallet with negative vote balance.");
                }
            }
        }
    }
}
