export interface AuthVerificationResult {
  isValid: boolean;
  payload?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export interface AuthVerifierPort {
  verifyToken(authHeader?: string): Promise<AuthVerificationResult>;
}

export interface DriveFileDetails {
  id: string;
  name: string;
  parents?: string[] | undefined;
  mimeType?: string | undefined;
}

export interface DriveServicePort {
  getFile(fileId: string, auth?: string): Promise<DriveFileDetails>;
  findOrCreateFolder(parentId: string, folderName: string, auth?: string): Promise<DriveFileDetails>;
  moveFile(fileId: string, currentParentId: string, targetFolderId: string, auth?: string): Promise<DriveFileDetails>;
}
