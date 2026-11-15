import type {
  DriveItemHierarchy,
  SourceContext,
  InferredRoutingResult,
  ExtractFieldsRequest,
  ExtractedFieldsResult,
  SourceParserSpaceTypeConfig,
  DriveSourceContextPort,
  SourceParserSpaceConfigPort,
  SourceParserPort,
  CandidateSpaceDescriptor,
} from './ports';

export * from './ports';

export const CSI_SECTION_REGEX = /(?<=^|[\s_.-])\d{6}-\d{3}(?:-[A-Za-z0-9]+)?(?=[\s_.-]|$)/;
export const FFE_SPEC_TAG_REGEX = /(?<=^|[\s_.-])[A-Za-z]{2}\d{3}[A-Za-z]?-[A-Za-z0-9]+(?=[\s_.-]|$)/i;
export const FFE_PROXIMITY_REGEX_1 = /(?<=^|[\s_.-])FF&?E(?=[\s_.-]|$).{0,100}(?<=^|[\s_.-])Submittal(?=[\s_.-]|$)/is;
export const FFE_PROXIMITY_REGEX_2 = /(?<=^|[\s_.-])Submittal(?=[\s_.-]|$).{0,100}(?<=^|[\s_.-])FF&?E(?=[\s_.-]|$)/is;

export const ARCH_SUBMITTAL_NOTIFICATION_REGEX =
  /(?<=^|[\s_.-])Submittal\s*#?\s*\d+\b/i;
export const PROCORE_AUTODESK_SUBMITTAL_REGEX =
  /(?<=^|[\s_.-])(?:Procore|Autodesk\s+(?:Build|Construction\s+Cloud)?)\s*(?:[-:]|\b).{0,50}(?<=^|[\s_.-])Submittal(?=[\s_.-]|$)/is;
export const PROCORE_AUTODESK_SUBMITTAL_REVERSE_REGEX =
  /(?<=^|[\s_.-])Submittal(?=[\s_.-]|$).{0,50}(?<=^|[\s_.-])(?:Procore|Autodesk\s+(?:Build|Construction\s+Cloud)?)(?=[\s_.-]|$)/is;

export const DRIVE_HIERARCHY_ERROR_MESSAGE =
  'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.';

export function extractTextFromHtml(html?: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }
  let text = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
  return text.replace(/\s+/g, ' ').trim();
}

export function inferSubmittalTypeFromText(
  text?: string
): 'submittal-arch' | 'submittal-ffe' | undefined {
  if (!text || typeof text !== 'string') {
    return undefined;
  }
  const clean = text.trim();
  if (clean.length === 0) {
    return undefined;
  }
  if (
    FFE_SPEC_TAG_REGEX.test(clean) ||
    FFE_PROXIMITY_REGEX_1.test(clean) ||
    FFE_PROXIMITY_REGEX_2.test(clean)
  ) {
    return 'submittal-ffe';
  }
  if (
    CSI_SECTION_REGEX.test(clean) ||
    ARCH_SUBMITTAL_NOTIFICATION_REGEX.test(clean) ||
    PROCORE_AUTODESK_SUBMITTAL_REGEX.test(clean) ||
    PROCORE_AUTODESK_SUBMITTAL_REVERSE_REGEX.test(clean)
  ) {
    return 'submittal-arch';
  }
  return undefined;
}

export function inferDocumentTypeFromFilename(
  filename?: string
): 'submittal-arch' | 'submittal-ffe' | undefined {
  return inferSubmittalTypeFromText(filename);
}

export function findSpaceTypeForDocumentType(
  spaceTypes: SourceParserSpaceTypeConfig[],
  documentTypeKey: string
): string | undefined {
  return spaceTypes.find((st) => st.spaceSchema?.allowedDocumentTypes?.includes(documentTypeKey))?.id;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findMatchingCandidatesInText(
  text: string,
  candidateSpaces: CandidateSpaceDescriptor[],
  isSubject: boolean
): CandidateSpaceDescriptor[] {
  const matches: CandidateSpaceDescriptor[] = [];

  for (const candidate of candidateSpaces) {
    const name = typeof candidate?.name === 'string' ? candidate.name.trim() : '';
    if (name.length <= 1) {
      continue;
    }

    if (name.length >= 2 && name.length <= 3) {
      if (!isSubject) {
        continue;
      }
      const pattern = new RegExp(
        `(?<=^|[\\s_.,;:()[\\]/\\\\\\-"'])${escapeRegExp(name)}(?=[\\s_.,;:()[\\]/\\\\\\-"']|$)`
      );
      if (pattern.test(text)) {
        matches.push(candidate);
      }
    } else if (name.length >= 4) {
      const pattern = new RegExp(
        `(?<=^|[\\s_.,;:()[\\]/\\\\\\-"'])${escapeRegExp(name)}(?=[\\s_.,;:()[\\]/\\\\\\-"']|$)`,
        'i'
      );
      if (pattern.test(text)) {
        matches.push(candidate);
      }
    }
  }

  return matches;
}

export function resolveCandidateTieBreaking(
  matches: CandidateSpaceDescriptor[]
): CandidateSpaceDescriptor | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0];
  }

  const sorted = [...matches].sort((a, b) => b.name.trim().length - a.name.trim().length);
  const longest = sorted[0];
  const longestName = longest.name.trim().toLowerCase();

  if (sorted[1].name.trim().length === longest.name.trim().length) {
    if (sorted[1].id !== longest.id || sorted[1].name.trim().toLowerCase() !== longestName) {
      return undefined;
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const other = sorted[i];
    if (other.id === longest.id) {
      continue;
    }
    const otherName = other.name.trim().toLowerCase();
    if (longestName.length <= otherName.length || !longestName.includes(otherName)) {
      return undefined;
    }
  }

  return longest;
}

export function matchCandidateSpaces(
  candidateSpaces?: CandidateSpaceDescriptor[],
  subject?: string,
  body?: string
): CandidateSpaceDescriptor | undefined {
  if (!candidateSpaces || candidateSpaces.length === 0) {
    return undefined;
  }

  if (subject && typeof subject === 'string' && subject.trim().length > 0) {
    const subjectMatches = findMatchingCandidatesInText(subject, candidateSpaces, true);
    if (subjectMatches.length > 0) {
      return resolveCandidateTieBreaking(subjectMatches);
    }
  }

  if (body && typeof body === 'string' && body.trim().length > 0) {
    const bodyMatches = findMatchingCandidatesInText(body, candidateSpaces, false);
    if (bodyMatches.length > 0) {
      return resolveCandidateTieBreaking(bodyMatches);
    }
  }

  return undefined;
}

export class SourceParserService implements SourceParserPort {
  constructor(
    private readonly driveContextPort: DriveSourceContextPort,
    private readonly spaceConfigPort: SourceParserSpaceConfigPort
  ) {}

  async extractFields(request: ExtractFieldsRequest): Promise<ExtractedFieldsResult> {
    void request;
    return { fields: {} };
  }

  async inferRouting(context: SourceContext): Promise<InferredRoutingResult> {
    const rawSpaceTypes = await this.spaceConfigPort.getDocumentSpaceTypes();
    const spaceTypes = rawSpaceTypes ?? [];

    if (context.email) {
      return this.inferFromEmail(context, spaceTypes);
    }

    const rawItems = context.items ?? [];
    const validItems = rawItems.filter(
      (item) => typeof item?.id === 'string' && item.id.trim().length > 0
    );
    if (validItems.length === 0) {
      return {};
    }

    let winningSpaceTypeId: string | undefined;
    let winningSpaceIdOrName: string | undefined;
    let winningDocumentTypeKey: string | undefined;

    try {
      for (const item of validItems) {
        const hierarchy = await this.driveContextPort.getItemHierarchy(item.id.trim());
        const itemResult = this.inferFromDriveHierarchy(hierarchy, spaceTypes);

        if (!winningSpaceTypeId) {
          if (itemResult.spaceTypeId) {
            // nosemgrep: domain-pass-through-read
            winningSpaceTypeId = itemResult.spaceTypeId;
            if (winningSpaceIdOrName === undefined && itemResult.spaceIdOrName !== undefined) {
              // nosemgrep: domain-pass-through-read
              winningSpaceIdOrName = itemResult.spaceIdOrName;
            }
            if (winningDocumentTypeKey === undefined && itemResult.documentTypeKey !== undefined) {
              // nosemgrep: domain-pass-through-read
              winningDocumentTypeKey = itemResult.documentTypeKey;
            }
          }
        } else {
          const isCompatible =
            itemResult.spaceTypeId === undefined || itemResult.spaceTypeId === winningSpaceTypeId;

          if (isCompatible) {
            if (winningSpaceIdOrName === undefined && itemResult.spaceIdOrName !== undefined) {
              // nosemgrep: domain-pass-through-read
              winningSpaceIdOrName = itemResult.spaceIdOrName;
            }
            if (winningDocumentTypeKey === undefined && itemResult.documentTypeKey !== undefined) {
              const spaceConfig = spaceTypes.find((st) => st.id === winningSpaceTypeId);
              const allowed = spaceConfig?.spaceSchema?.allowedDocumentTypes ?? [];
              if (allowed.length === 0 || allowed.includes(itemResult.documentTypeKey)) {
                // nosemgrep: domain-pass-through-read
                winningDocumentTypeKey = itemResult.documentTypeKey;
              }
            }
          }
        }

        if (
          winningSpaceTypeId !== undefined &&
          winningSpaceIdOrName !== undefined &&
          winningDocumentTypeKey !== undefined
        ) {
          break;
        }
      }
    } catch {
      return {
        statusMessages: [DRIVE_HIERARCHY_ERROR_MESSAGE],
      };
    }

    return {
      ...(winningSpaceTypeId !== undefined ? { spaceTypeId: winningSpaceTypeId } : {}),
      ...(winningSpaceIdOrName !== undefined ? { spaceIdOrName: winningSpaceIdOrName } : {}),
      ...(winningDocumentTypeKey !== undefined ? { documentTypeKey: winningDocumentTypeKey } : {}),
    };
  }

  private inferFromEmail(
    context: SourceContext,
    spaceTypes: SourceParserSpaceTypeConfig[]
  ): InferredRoutingResult {
    const email = context.email!;
    const attachmentFilenames: string[] = [];

    if (context.items) {
      for (const item of context.items) {
        if (item?.name && typeof item.name === 'string' && item.name.trim().length > 0) {
          attachmentFilenames.push(item.name.trim());
        }
      }
    }

    if (email.attachments) {
      for (const att of email.attachments) {
        // nosemgrep: domain-pass-through-read
        const name = att.name;
        if (name && typeof name === 'string' && name.trim().length > 0) {
          const trimmed = name.trim();
          if (!attachmentFilenames.includes(trimmed)) {
            attachmentFilenames.push(trimmed);
          }
        }
      }
    }

    let inferredDocType: string | undefined;
    let inferredDocTypeSpaceTypeId: string | undefined;

    // 1. Inspect candidate/selected attachment filenames in order
    for (const filename of attachmentFilenames) {
      const match = inferSubmittalTypeFromText(filename);
      if (match) {
        inferredDocType = match;
        inferredDocTypeSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, match);
        break;
      }
    }

    // 2. Inspect subject
    if (!inferredDocType && email.subject && typeof email.subject === 'string' && email.subject.trim().length > 0) {
      const match = inferSubmittalTypeFromText(email.subject);
      if (match) {
        inferredDocType = match;
        inferredDocTypeSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, match);
      }
    }

    // 3. Inspect body text (plainTextBody or derived from htmlBody)
    // nosemgrep: domain-pass-through-read
    const rawPlain = email.plainTextBody;
    const hasPlain = typeof rawPlain === 'string' && rawPlain.trim().length > 0;
    const bodyText = hasPlain
      ? rawPlain.trim()
      : extractTextFromHtml(email.htmlBody);

    if (!inferredDocType && bodyText.length > 0) {
      const match = inferSubmittalTypeFromText(bodyText);
      if (match) {
        inferredDocType = match;
        inferredDocTypeSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, match);
      }
    }

    // 4. Candidate spaces matching in subject first, body text second
    const winningCandidate = matchCandidateSpaces(
      context.candidateSpaces,
      email.subject,
      bodyText
    );

    let winningSpaceTypeId: string | undefined;
    let winningSpaceIdOrName: string | undefined;

    if (inferredDocTypeSpaceTypeId !== undefined) {
      winningSpaceTypeId = inferredDocTypeSpaceTypeId;
      if (winningCandidate) {
        // nosemgrep: domain-pass-through-read
        const candidateType = winningCandidate.typeId;
        const isCompatible = candidateType === undefined || candidateType === inferredDocTypeSpaceTypeId;
        if (isCompatible) {
          // nosemgrep: domain-pass-through-read
          winningSpaceIdOrName = winningCandidate.id;
        }
      }
    } else if (winningCandidate) {
      // nosemgrep: domain-pass-through-read
      winningSpaceIdOrName = winningCandidate.id;
      if (winningCandidate.typeId !== undefined) {
        // nosemgrep: domain-pass-through-read
        winningSpaceTypeId = winningCandidate.typeId;
      }
    }

    return {
      ...(winningSpaceTypeId !== undefined ? { spaceTypeId: winningSpaceTypeId } : {}),
      ...(winningSpaceIdOrName !== undefined ? { spaceIdOrName: winningSpaceIdOrName } : {}),
      ...(inferredDocType !== undefined ? { documentTypeKey: inferredDocType } : {}),
    };
  }

  private inferFromDriveHierarchy(
    hierarchy: DriveItemHierarchy,
    spaceTypes: SourceParserSpaceTypeConfig[]
  ): InferredRoutingResult {
    let winningSpaceTypeId: string | undefined;
    let winningSpaceIdOrName: string | undefined;

    const folderBackedTypes = spaceTypes.filter(
      (st) => st.storageConfig?.fetchMethod === 'folders'
    );
    const sharedDrivesTypes = spaceTypes.filter(
      (st) => st.storageConfig?.fetchMethod === 'shared_drives'
    );

    const dedicatedSharedDriveNames = new Set(
      folderBackedTypes
        .map((st) =>
          typeof st.storageConfig?.sharedDriveName === 'string'
            ? st.storageConfig.sharedDriveName.trim().toLowerCase()
            : undefined
        )
        .filter((name): name is string => name !== undefined && name.length > 0)
    );

    // 1. Evaluate folder-backed space types first
    for (const spaceType of folderBackedTypes) {
      const cfg = spaceType.storageConfig as SourceParserSpaceTypeConfig['storageConfig'];
      const expectedSharedDriveName =
        typeof cfg?.sharedDriveName === 'string'
          ? cfg.sharedDriveName.trim().toLowerCase()
          : undefined;
      const expectedParentFolderName =
        typeof cfg?.parentFolderName === 'string'
          ? cfg.parentFolderName.trim().toLowerCase()
          : undefined;

      if (expectedSharedDriveName) {
        const actualDriveName = hierarchy.driveName?.trim().toLowerCase();
        if (actualDriveName !== expectedSharedDriveName) {
          continue;
        }
      }

      if (expectedParentFolderName) {
        const parentIndex = hierarchy.ancestors.findIndex(
          (a) => a.name.trim().toLowerCase() === expectedParentFolderName
        );

        if (parentIndex !== -1) {
          winningSpaceTypeId = spaceType.id as string;
          if (parentIndex + 1 < hierarchy.ancestors.length) {
            const childFolder = hierarchy.ancestors[parentIndex + 1];
            winningSpaceIdOrName = childFolder.id as string;
          } else {
            winningSpaceIdOrName = hierarchy.item.id as string;
          }
          break;
        }
      }
    }

    // 2. Evaluate Shared-Drive-backed space types second
    if (!winningSpaceTypeId) {
      const itemDriveId = hierarchy.driveId?.trim();
      const itemDriveName = hierarchy.driveName?.trim().toLowerCase();

      if (itemDriveId && (!itemDriveName || !dedicatedSharedDriveNames.has(itemDriveName))) {
        for (const spaceType of sharedDrivesTypes) {
          winningSpaceTypeId = spaceType.id as string;
          winningSpaceIdOrName = itemDriveId;
          break;
        }
      }
    }

    // 3. DocumentType inference from ancestor folder paths
    let documentTypeKey = this.inferDocumentTypeFromHierarchy(
      hierarchy,
      winningSpaceTypeId
    );

    // 4. Underscore-safe submittal filename fallback when ancestor folder paths do not resolve a DocumentType
    if (!documentTypeKey) {
      const filenameMatch = inferDocumentTypeFromFilename(hierarchy.item.name);
      if (filenameMatch) {
        documentTypeKey = filenameMatch;
        if (!winningSpaceTypeId) {
          winningSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, documentTypeKey);
        }
      }
    }

    return {
      ...(winningSpaceTypeId !== undefined ? { spaceTypeId: winningSpaceTypeId } : {}),
      ...(winningSpaceIdOrName !== undefined ? { spaceIdOrName: winningSpaceIdOrName } : {}),
      ...(documentTypeKey !== undefined ? { documentTypeKey } : {}),
    };
  }

  private inferDocumentTypeFromHierarchy(
    hierarchy: DriveItemHierarchy,
    spaceTypeId?: string
  ): string | undefined {
    if (spaceTypeId === 'proposals') {
      return 'communication-proposal';
    }

    const ancestorNames = hierarchy.ancestors.map((a) => a.name.trim().toLowerCase());

    if (
      ancestorNames.some(
        (name) =>
          name === 'communications' ||
          (name.includes('communication') && !name.includes('1 admin'))
      )
    ) {
      if (spaceTypeId === 'proposals') {
        return 'communication-proposal';
      }
    }

    const has6Construction = ancestorNames.some(
      (name) =>
        name === '6 construction' ||
        name.startsWith('6 construction/') ||
        name.startsWith('6 construction /')
    );
    if (has6Construction) {
      return 'submittal-arch';
    }

    const has3FFE = ancestorNames.some(
      (name) =>
        name === '3 ffe' ||
        name.startsWith('3 ffe/') ||
        name.startsWith('3 ffe /')
    );
    if (has3FFE) {
      return 'submittal-ffe';
    }

    const has1AdminComm = ancestorNames.some(
      (name) =>
        name === '1 admin/communication' ||
        name === '1 admin / communication'
    );
    if (has1AdminComm) {
      return 'communication-project';
    }

    const adminIndex = ancestorNames.findIndex((name) => name === '1 admin');
    if (
      adminIndex !== -1 &&
      ancestorNames.slice(adminIndex + 1).some((n) => n.includes('communication'))
    ) {
      return 'communication-project';
    }

    return undefined;
  }
}
