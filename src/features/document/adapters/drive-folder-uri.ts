/**
 * Resolves the Google Drive web URL for a folder using its `webViewLink` when present,
 * falling back to the canonical `https://drive.google.com/drive/folders/<folderId>` URL.
 */
export function resolveDriveFolderUri(
  folderId: string | undefined,
  webViewLink?: string | undefined
): string | undefined {
  const trimmedWebViewLink = typeof webViewLink === 'string' ? webViewLink.trim() : '';
  if (trimmedWebViewLink.length > 0) {
    return trimmedWebViewLink;
  }
  const trimmedFolderId = typeof folderId === 'string' ? folderId.trim() : '';
  if (trimmedFolderId.length === 0) {
    return undefined;
  }
  return `https://drive.google.com/drive/folders/${trimmedFolderId}`;
}
