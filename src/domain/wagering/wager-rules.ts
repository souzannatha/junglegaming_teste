import {
  WagerFailureCode,
  WagerRuleViolationError,
} from '../errors/domain.error.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

export class WagerRules {
  static validateReference(
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    existingTransactions: readonly WagerTransaction[] = [],
  ): void {
    if (!reference) {
      if (
        transaction.requiresReference() ||
        transaction.referenceExternalTransactionId !== undefined
      ) {
        throw new WagerRuleViolationError(WagerFailureCode.ReferenceNotFound);
      }
      return;
    }

    if (
      transaction.referenceExternalTransactionId !==
        reference.externalTransactionId ||
      transaction.providerId !== reference.providerId
    ) {
      throw new WagerRuleViolationError(WagerFailureCode.ReferenceNotFound);
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new WagerRuleViolationError(WagerFailureCode.ReferenceNotProcessed);
    }

    if (
      transaction.playerId !== reference.playerId ||
      transaction.walletId !== reference.walletId ||
      transaction.money.currency !== reference.money.currency ||
      transaction.roundId !== reference.roundId
    ) {
      throw new WagerRuleViolationError(
        WagerFailureCode.ReferenceContextMismatch,
      );
    }

    this.assertAllowedReferenceKind(transaction.kind, reference.kind);

    if (
      (transaction.kind === WagerTransactionKind.Refund ||
        transaction.kind === WagerTransactionKind.Rollback) &&
      !transaction.money.equals(reference.money)
    ) {
      throw new WagerRuleViolationError(
        WagerFailureCode.ReferenceAmountMismatch,
      );
    }

    if (
      transaction.kind === WagerTransactionKind.Refund ||
      transaction.kind === WagerTransactionKind.Rollback
    ) {
      const alreadyReversed = existingTransactions.some(
        (existing) =>
          existing.id !== transaction.id &&
          existing.kind === transaction.kind &&
          existing.referenceExternalTransactionId ===
            reference.externalTransactionId &&
          existing.providerId === reference.providerId &&
          existing.status !== WagerTransactionStatus.Rejected &&
          existing.status !== WagerTransactionStatus.Failed,
      );

      if (alreadyReversed) {
        throw new WagerRuleViolationError(
          WagerFailureCode.ReferenceAlreadyReversed,
        );
      }
    }
  }

  private static assertAllowedReferenceKind(
    transactionKind: WagerTransactionKind,
    referenceKind: WagerTransactionKind,
  ): void {
    const isAllowed =
      (transactionKind === WagerTransactionKind.Win &&
        referenceKind === WagerTransactionKind.Bet) ||
      (transactionKind === WagerTransactionKind.Refund &&
        referenceKind === WagerTransactionKind.Bet) ||
      (transactionKind === WagerTransactionKind.Rollback &&
        (referenceKind === WagerTransactionKind.Bet ||
          referenceKind === WagerTransactionKind.Win ||
          referenceKind === WagerTransactionKind.Refund));

    if (!isAllowed) {
      throw new WagerRuleViolationError(
        WagerFailureCode.ReferenceTypeNotAllowed,
      );
    }
  }
}
