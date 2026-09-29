const officialSyncTitle = /^\s*sync\/official(?:\s|$)/i;
const officialSyncBranch = /^sync\/official(?:[-_/]|$)/i;

export function isUpstreamSyncPullRequest(pr) {
  return officialSyncTitle.test(pr?.title || '') ||
    officialSyncBranch.test(pr?.head?.ref || '');
}

export function isUpstreamSyncBranch(branch) {
  return officialSyncBranch.test(branch || '');
}
