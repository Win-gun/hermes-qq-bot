// Seal covered input at the wire boundary, not at model completion or while
// waiting for the shared send slot. Queue waits remain cancelable until then.
export function replyDeliveryConfig(config, job, signal, revision, isCurrent = () => true) {
  return { ...config,
    __deliveryGuard: () => !job.dropped && !signal.aborted
      && Number(job.contextRevision || 0) === revision && isCurrent(),
    __deliveryStarted: () => {
      job.deliveryStarted = true;
      job.deliveryMessageIds ||= [...new Set((job.messageIds || []).map(String))];
    }
  };
}
