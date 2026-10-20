import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewSectionSchema } from '../domain';
import { buildFileSelectionSection } from './file-selection';
import type { SelectionItem } from '../ports';

describe('File Selection Block', () => {
  const sampleFiles: SelectionItem[] = [
    { text: 'Proposal.pdf', value: 'file-1', selected: true },
    { text: 'Contract.pdf', value: 'file-2', selected: true },
  ];

  it('renders a collapsible section with CHECK_BOX selectionInput when files are provided', () => {
    const section = buildFileSelectionSection(sampleFiles);

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('File Selection');
    expect(section.collapsible).toBe(true);
    expect(section.uncollapsibleWidgetsCount).toBeUndefined();
    expect(section.widgets).toHaveLength(1);

    const widget = section.widgets[0];
    expect(widget.selectionInput).toBeDefined();
    expect(widget.selectionInput?.name).toBe('SelectFiles');
    expect(widget.selectionInput?.type).toBe('CHECK_BOX');
    expect(widget.selectionInput?.items).toEqual(sampleFiles);
    expect(widget.selectionInput?.label).toBeUndefined();
    expect(widget.selectionInput?.onChangeAction).toBeUndefined();
  });

  it('renders a collapsible section with textParagraph when files array is empty', () => {
    const section = buildFileSelectionSection([]);

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('File Selection');
    expect(section.collapsible).toBe(true);
    expect(section.widgets).toHaveLength(1);

    const widget = section.widgets[0];
    expect(widget.textParagraph).toBeDefined();
    expect(widget.textParagraph?.text).toBe('No files selected.');
    expect(widget.selectionInput).toBeUndefined();
  });

  it('renders textParagraph fallback when files argument is undefined', () => {
    const section = buildFileSelectionSection(undefined);

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('File Selection');
    expect(section.collapsible).toBe(true);
    expect(section.widgets).toHaveLength(1);
    expect(section.widgets[0].textParagraph?.text).toBe('No files selected.');
  });

  it('respects custom options for sectionHeader, collapsible, inputName, and emptyText', () => {
    const customWithFiles = buildFileSelectionSection(sampleFiles, {
      sectionHeader: 'Attached Documents',
      collapsible: false,
      inputName: 'CustomFiles',
    });

    expect(Value.Check(UiViewSectionSchema, customWithFiles)).toBe(true);
    expect(customWithFiles.header).toBe('Attached Documents');
    expect(customWithFiles.collapsible).toBe(false);
    expect(customWithFiles.widgets[0].selectionInput?.name).toBe('CustomFiles');

    const customEmpty = buildFileSelectionSection([], {
      sectionHeader: 'Attached Documents',
      collapsible: false,
      emptyText: 'Nothing to see here.',
    });

    expect(Value.Check(UiViewSectionSchema, customEmpty)).toBe(true);
    expect(customEmpty.header).toBe('Attached Documents');
    expect(customEmpty.collapsible).toBe(false);
    expect(customEmpty.widgets[0].textParagraph?.text).toBe('Nothing to see here.');
  });

  it('normalizes SelectionState object input correctly', () => {
    const selectionState = {
      spaceTypes: [],
      spaces: [],
      documentTypes: [],
      files: sampleFiles,
    };

    const section = buildFileSelectionSection(selectionState);

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('File Selection');
    expect(section.widgets[0].selectionInput?.items).toEqual(sampleFiles);
  });

  it('handles SelectionState with undefined or empty files by rendering fallback', () => {
    const stateEmptyFiles = {
      spaceTypes: [],
      spaces: [],
      documentTypes: [],
      files: [],
    };
    const sectionEmpty = buildFileSelectionSection(stateEmptyFiles);
    expect(sectionEmpty.widgets[0].textParagraph?.text).toBe('No files selected.');

    const stateUndefinedFiles = {
      spaceTypes: [],
      spaces: [],
      documentTypes: [],
    };
    const sectionUndefined = buildFileSelectionSection(stateUndefinedFiles);
    expect(sectionUndefined.widgets[0].textParagraph?.text).toBe('No files selected.');
  });

  describe('toggleInput option', () => {
    it('appends SWITCH widget below file selection checkbox when files are present', () => {
      const section = buildFileSelectionSection(sampleFiles, {
        formData: { SaveEmailToPdf: true },
        toggleInput: {
          name: 'SaveEmailToPdf',
          text: 'Save Email to PDF',
          value: 'true',
        },
      });

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(2);

      // First widget: files checklist
      expect(section.widgets[0].selectionInput?.name).toBe('SelectFiles');
      expect(section.widgets[0].selectionInput?.type).toBe('CHECK_BOX');
      expect(section.widgets[0].selectionInput?.items).toEqual(sampleFiles);

      // Second widget: SWITCH toggle
      const switchWidget = section.widgets[1].selectionInput;
      expect(switchWidget).toBeDefined();
      expect(switchWidget?.name).toBe('SaveEmailToPdf');
      expect(switchWidget?.type).toBe('SWITCH');
      expect(switchWidget?.items).toEqual([
        { text: 'Save Email to PDF', value: 'true', selected: true },
      ]);
    });

    it('appends SWITCH widget below emptyText textParagraph when files array is empty', () => {
      const section = buildFileSelectionSection([], {
        emptyText: 'No attachments found.',
        formData: { SaveEmailToPdf: false },
        toggleInput: {
          name: 'SaveEmailToPdf',
          text: 'Save Email to PDF',
          value: 'true',
        },
      });

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(2);

      // First widget: empty text
      expect(section.widgets[0].textParagraph?.text).toBe('No attachments found.');

      // Second widget: SWITCH toggle with selected false
      const switchWidget = section.widgets[1].selectionInput;
      expect(switchWidget).toBeDefined();
      expect(switchWidget?.name).toBe('SaveEmailToPdf');
      expect(switchWidget?.type).toBe('SWITCH');
      expect(switchWidget?.items).toEqual([
        { text: 'Save Email to PDF', value: 'true', selected: false },
      ]);
    });

    it('defaults value to true and includes onChangeAction when provided', () => {
      const section = buildFileSelectionSection([], {
        formData: {},
        toggleInput: {
          name: 'SaveEmailToPdf',
          text: 'Save Email to PDF',
          onChangeAction: { action: 'onTogglePdf' },
        },
      });

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      const switchWidget = section.widgets[1].selectionInput;
      expect(switchWidget?.items?.[0].value).toBe('true');
      expect(switchWidget?.items?.[0].selected).toBe(false);
      expect(switchWidget?.onChangeAction).toEqual({ action: 'onTogglePdf' });
    });
  });

  describe('fileSourceDropdown and widget swapping', () => {
    const sampleSources = [
      { text: 'Email Attachments', value: 'Email Attachments', selected: true },
      { text: 'Google Drive URL', value: 'Google Drive URL', selected: false },
    ];

    it('renders file source DROPDOWN at the top when fileSourceDropdown and fileSources are provided', () => {
      const section = buildFileSelectionSection(
        {
          spaceTypes: [],
          spaces: [],
          documentTypes: [],
          files: sampleFiles,
          fileSources: sampleSources,
        },
        {
          fileSourceDropdown: {
            name: 'SelectFileSource',
            label: 'File Source',
            onChangeAction: { action: 'onFileSourceChange' },
          },
        }
      );

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(2);

      const dropdown = section.widgets[0].selectionInput;
      expect(dropdown).toBeDefined();
      expect(dropdown?.name).toBe('SelectFileSource');
      expect(dropdown?.label).toBe('File Source');
      expect(dropdown?.type).toBe('DROPDOWN');
      expect(dropdown?.items).toEqual(sampleSources);
      expect(dropdown?.onChangeAction).toEqual({ action: 'onFileSourceChange' });

      // Second widget is the files checkbox list
      expect(section.widgets[1].selectionInput?.name).toBe('SelectFiles');
      expect(section.widgets[1].selectionInput?.type).toBe('CHECK_BOX');
    });

    it('renders textInput when formData.SelectFileSource === Google Drive URL', () => {
      const section = buildFileSelectionSection(
        {
          spaceTypes: [],
          spaces: [],
          documentTypes: [],
          files: sampleFiles,
          fileSources: sampleSources,
        },
        {
          formData: {
            SelectFileSource: 'Google Drive URL',
            InputDriveURL: 'https://drive.google.com/open?id=xyz',
          },
          fileSourceDropdown: {
            name: 'SelectFileSource',
            label: 'File Source',
          },
          urlInput: {
            name: 'InputDriveURL',
            label: 'Google Drive URL',
            hintText: 'Enter Google Drive file or folder URL',
            activeOnSourceValue: 'Google Drive URL',
          },
          toggleInput: {
            name: 'SaveEmailToPdf',
            text: 'Save Email to PDF',
            value: 'true',
          },
        }
      );

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(3);

      // Widget 0: Dropdown
      expect(section.widgets[0].selectionInput?.name).toBe('SelectFileSource');

      // Widget 1: textInput for Drive URL
      const textInput = section.widgets[1].textInput;
      expect(textInput).toBeDefined();
      expect(textInput?.name).toBe('InputDriveURL');
      expect(textInput?.label).toBe('Google Drive URL');
      expect(textInput?.hintText).toBe('Enter Google Drive file or folder URL');
      expect(textInput?.value).toBe('https://drive.google.com/open?id=xyz');

      // Widget 2: SWITCH toggle at bottom
      expect(section.widgets[2].selectionInput?.name).toBe('SaveEmailToPdf');
      expect(section.widgets[2].selectionInput?.type).toBe('SWITCH');
    });

    it('renders empty string in textInput when formData has no url value', () => {
      const section = buildFileSelectionSection(
        {
          spaceTypes: [],
          spaces: [],
          documentTypes: [],
          files: sampleFiles,
          fileSources: sampleSources,
        },
        {
          formData: {
            SelectFileSource: 'Google Drive URL',
          },
          fileSourceDropdown: {
            name: 'SelectFileSource',
          },
          urlInput: {
            name: 'InputDriveURL',
            label: 'Google Drive URL',
            hintText: 'Enter URL',
            activeOnSourceValue: 'Google Drive URL',
          },
        }
      );

      expect(section.widgets[1].textInput?.value).toBe('');
    });

    it('swaps back to checkbox list when SelectFileSource is Email Attachments and toggle stays at bottom', () => {
      const section = buildFileSelectionSection(
        {
          spaceTypes: [],
          spaces: [],
          documentTypes: [],
          files: sampleFiles,
          fileSources: sampleSources,
        },
        {
          formData: {
            SelectFileSource: 'Email Attachments',
          },
          fileSourceDropdown: {
            name: 'SelectFileSource',
            label: 'File Source',
          },
          urlInput: {
            name: 'InputDriveURL',
            label: 'Google Drive URL',
            hintText: 'Enter URL',
            activeOnSourceValue: 'Google Drive URL',
          },
          toggleInput: {
            name: 'SaveEmailToPdf',
            text: 'Save Email to PDF',
            value: 'true',
          },
        }
      );

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(3);

      // Widget 0: Dropdown
      expect(section.widgets[0].selectionInput?.name).toBe('SelectFileSource');

      // Widget 1: CHECK_BOX for attachments
      expect(section.widgets[1].selectionInput?.name).toBe('SelectFiles');
      expect(section.widgets[1].selectionInput?.type).toBe('CHECK_BOX');
      expect(section.widgets[1].selectionInput?.items).toEqual(sampleFiles);

      // Widget 2: SWITCH toggle
      expect(section.widgets[2].selectionInput?.name).toBe('SaveEmailToPdf');
      expect(section.widgets[2].selectionInput?.type).toBe('SWITCH');
    });

    it('swaps back to textParagraph when SelectFileSource is Email Attachments and files are empty', () => {
      const section = buildFileSelectionSection(
        {
          spaceTypes: [],
          spaces: [],
          documentTypes: [],
          files: [],
          fileSources: sampleSources,
        },
        {
          emptyText: 'No attachments found.',
          formData: {
            SelectFileSource: 'Email Attachments',
          },
          fileSourceDropdown: {
            name: 'SelectFileSource',
          },
          urlInput: {
            name: 'InputDriveURL',
            label: 'Google Drive URL',
            hintText: 'Enter URL',
            activeOnSourceValue: 'Google Drive URL',
          },
          toggleInput: {
            name: 'SaveEmailToPdf',
            text: 'Save Email to PDF',
            value: 'true',
          },
        }
      );

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(3);

      // Widget 0: Dropdown
      expect(section.widgets[0].selectionInput?.name).toBe('SelectFileSource');

      // Widget 1: textParagraph
      expect(section.widgets[1].textParagraph?.text).toBe('No attachments found.');

      // Widget 2: SWITCH toggle
      expect(section.widgets[2].selectionInput?.name).toBe('SaveEmailToPdf');
    });

    it('renders itemDropdown at widget index 0 above SelectFileSource in both Email Attachments and Google Drive URL modes', () => {
      const threadMessages: SelectionItem[] = [
        { text: '(1) Alice | 261019', value: 'msg-1', selected: true },
        { text: '(2) Bob | 261019', value: 'msg-2', selected: false },
      ];

      // Email Attachments mode
      const emailSection = buildFileSelectionSection(
        {
          spaceTypes: [],
          spaces: [],
          documentTypes: [],
          files: sampleFiles,
          fileSources: sampleSources,
          threadMessages,
        },
        {
          formData: {
            SelectEmailMessage: 'msg-1',
            SelectFileSource: 'Email Attachments',
          },
          itemDropdown: {
            name: 'SelectEmailMessage',
            label: 'Email',
          },
          fileSourceDropdown: {
            name: 'SelectFileSource',
            label: 'File Source',
          },
          urlInput: {
            name: 'InputDriveURL',
            label: 'Google Drive URL',
            hintText: 'Enter URL',
            activeOnSourceValue: 'Google Drive URL',
          },
          toggleInput: {
            name: 'SaveEmailToPdf',
            text: 'Save Email to PDF',
            value: 'true',
          },
        }
      );

      expect(Value.Check(UiViewSectionSchema, emailSection)).toBe(true);
      expect(emailSection.widgets).toHaveLength(4);
      // Widget 0: itemDropdown
      expect(emailSection.widgets[0].selectionInput?.name).toBe('SelectEmailMessage');
      expect(emailSection.widgets[0].selectionInput?.label).toBe('Email');
      expect(emailSection.widgets[0].selectionInput?.type).toBe('DROPDOWN');
      expect(emailSection.widgets[0].selectionInput?.items).toEqual(threadMessages);
      // Widget 1: fileSourceDropdown
      expect(emailSection.widgets[1].selectionInput?.name).toBe('SelectFileSource');
      // Widget 2: CHECK_BOX
      expect(emailSection.widgets[2].selectionInput?.name).toBe('SelectFiles');
      // Widget 3: SWITCH
      expect(emailSection.widgets[3].selectionInput?.name).toBe('SaveEmailToPdf');

      // Google Drive URL mode
      const driveSection = buildFileSelectionSection(
        {
          spaceTypes: [],
          spaces: [],
          documentTypes: [],
          files: sampleFiles,
          fileSources: sampleSources,
          threadMessages,
        },
        {
          formData: {
            SelectEmailMessage: 'msg-1',
            SelectFileSource: 'Google Drive URL',
            InputDriveURL: 'https://drive.google.com/file/d/123/view',
          },
          itemDropdown: {
            name: 'SelectEmailMessage',
            label: 'Email',
            items: threadMessages,
          },
          fileSourceDropdown: {
            name: 'SelectFileSource',
            label: 'File Source',
          },
          urlInput: {
            name: 'InputDriveURL',
            label: 'Google Drive URL',
            hintText: 'Enter URL',
            activeOnSourceValue: 'Google Drive URL',
          },
          toggleInput: {
            name: 'SaveEmailToPdf',
            text: 'Save Email to PDF',
            value: 'true',
          },
        }
      );

      expect(Value.Check(UiViewSectionSchema, driveSection)).toBe(true);
      expect(driveSection.widgets).toHaveLength(4);
      // Widget 0: itemDropdown
      expect(driveSection.widgets[0].selectionInput?.name).toBe('SelectEmailMessage');
      expect(driveSection.widgets[0].selectionInput?.label).toBe('Email');
      expect(driveSection.widgets[0].selectionInput?.type).toBe('DROPDOWN');
      // Widget 1: fileSourceDropdown
      expect(driveSection.widgets[1].selectionInput?.name).toBe('SelectFileSource');
      // Widget 2: textInput (InputDriveURL)
      expect(driveSection.widgets[2].textInput?.name).toBe('InputDriveURL');
      // Widget 3: SWITCH
      expect(driveSection.widgets[3].selectionInput?.name).toBe('SaveEmailToPdf');
    });

    it('omits itemDropdown when itemDropdown option is not provided or items are empty', () => {
      const section = buildFileSelectionSection(
        {
          spaceTypes: [],
          spaces: [],
          documentTypes: [],
          files: sampleFiles,
          fileSources: sampleSources,
        },
        {
          fileSourceDropdown: {
            name: 'SelectFileSource',
            label: 'File Source',
          },
        }
      );

      expect(section.widgets).toHaveLength(2);
      expect(section.widgets[0].selectionInput?.name).toBe('SelectFileSource');
      expect(section.widgets[1].selectionInput?.name).toBe('SelectFiles');
    });
  });
});

