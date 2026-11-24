# Google Workspace Add-on Prototype

A single, double-click-runnable HTML file pairing a **300px Drive/Gmail sidebar simulator** (`?variant=` layouts) with **guided walkthroughs, fault injection, and a live state/`onSubmit` contract inspector**.

Use this branch when prototyping **Google Workspace Add-on sidebar UX together with CQRS `UiProcessManager` / `SchemaDrivenUi` state transitions**. For pure backend state/logic without card layout, use [LOGIC.md](LOGIC.md); for web UI layouts without Add-on state transitions, use [UI.md](UI.md).

## Hard `google.apps.card.v1` sidebar constraints

- **Single-column layout only**: Drive and Gmail sidebars reject `Columns` widgets. Stack single-column widgets vertically (`decoratedText`, `selectionInput`, `textInput`, `buttonList`, `textParagraph`, `divider`) and keep `countCardWidgets(card).disallowed` empty.
- **100-widget card cap**: Keep total widgets across all sections at `<= 100`. Cap dynamic lists with `sliceWithWidgetBudget` and reserve one trailing overflow `decoratedText` + `openLink` row when items exceed budget.
- **`decoratedText` truncation and wrapping**: `topLabel` truncates with ellipsis at one line; `text` wraps only when `wrapText: true`; `bottomLabel` wraps underneath. Place compact metadata in `topLabel`, primary HTML text with `wrapText: true` in `text`, and secondary detail in `bottomLabel`.
- **HTML-only text formatting**: Format `text` and `textParagraph` with safe HTML tags (`<b>`, `<i>`, `<br>`, `<code>`, `<font color="#hex">`) and pass interpolated data through `escapeHtml`; host renderers ignore Markdown.
- **Collapsible sections & `uncollapsibleWidgetsCount`**: Set `collapsible: true` with `uncollapsibleWidgetsCount` (`0` for fully collapsed drawers, `1+` to pin header/summary/latest rows above the fold). Omit `collapsible` when no overflow rows follow `uncollapsibleWidgetsCount`.
- **Navigation & feedback**: Return `updateCard` with an optional toast `notification` for in-place state changes; return `pushCard` on initial mount or full reset; use `openLink` to open external URLs without a server round-trip and `action` for state-mutating clicks handled by `UiProcessManager`.

## Pure-module contract (`<script id="portable-prototype-module">`)

- Exposes `globalThis.PrototypeMachine` with **zero browser or DOM references** (`window`, `document`, `location` remain undefined in Node `vm`).
- Keeps reusable card helpers (`countCardWidgets`, `escapeHtml`, `renderTemplate`, `sliceWithWidgetBudget`) separate from `/* === CUSTOMIZE HERE === */` domain blocks.
- Preserves CQRS boundaries: `reduceUiProcessEvent` handles command transitions and `navigationType`/`notification` intents; `queryContext` + `composeWorkspaceCard` build read-only cards.
- Isolates ephemeral UI selection keys (`Select*`, `InputDriveURL`, etc.) from domain payloads via `isSelectionKey` and `extractDocumentData` so the `onSubmit` inspector proves selection keys stay out of `Document.data` and flow through `executionContext`.

## Process

### 1. Copy the scaffold & state the question

1. Copy [resources/workspace-addon-scaffold.prototype.html](resources/workspace-addon-scaffold.prototype.html) to `scratch/<name>.prototype.html` (gitignored, opens directly via double-click).
2. Update `<title>` and the top throwaway banner with the feature name and the design question being answered.

*Done when*: `scratch/<name>.prototype.html` opens cleanly in a browser with the question visible in the banner.

### 2. Customize the pure module & shell bindings

1. Edit inside `/* === CUSTOMIZE HERE === */` in `<script id="portable-prototype-module">` (`EPHEMERAL_UI_SELECTION_KEYS`, domain schemas/store, `queryContext`, `extractDocumentData`, `reduceUiProcessEvent`, `VARIANTS`, `buildVariant{A,B,C}Card`, `SCENARIOS`). Keep the module pure JS with zero DOM globals.
2. Design **3 structurally distinct variants (`A`, `B`, `C`)** differing in section placement, widget controls (`DROPDOWN` vs `RADIO_BUTTON`, trailing button vs whole-row `openLink`), and collapse pinning (`uncollapsibleWidgetsCount`).
3. Author scenarios in `SCENARIOS` covering happy path, missing/ambiguous context, fault injection (`403`/`503`/malformed rows), `onSubmit` contract verification, and a high-row-count case exercising the 100-widget cap guard.
4. Update the matching `/* === CUSTOMIZE HERE === */` Free-Play/Fault buttons and State & Contract inspector fields in `<script id="prototype-ui-shell">`.

*Done when*: all 3 variants, all scenarios, free-play controls, and inspector views reflect the target feature with zero placeholder text remaining.

### 3. Verify Node isolation & widget cap before handing over

Run an inline `vm` smoke check against `scratch/<name>.prototype.html` (bash heredoc shown; on PowerShell wrap the JS in `@' ... '@ | node -`):

```bash
node - <<'EOF'
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('scratch/<name>.prototype.html', 'utf8');
const extract = (id) => {
  const m = html.match(new RegExp(`<script\\s+id="${id}">([\\s\\S]*?)<\\/script>`));
  if (!m) throw new Error(`Missing <script id="${id}">`);
  return m[1];
};

const portable = extract('portable-prototype-module');
const shell = extract('prototype-ui-shell');
if (/\b(window|document|location)\b/.test(portable)) throw new Error('DOM global found in portable module');

new vm.Script(portable);
new vm.Script(shell);

const ctx = vm.createContext({});
vm.runInContext(portable, ctx);
const M = ctx.PrototypeMachine;

for (const sc of M.SCENARIOS) {
  for (const v of M.VARIANTS.map((x) => x.key)) {
    for (const host of ['DRIVE', 'GMAIL']) {
      const store = M.createInitialStore();
      let state = M.createInitialState({ ...sc.initialState, hostApp: host });
      const check = (label) => {
        const { card } = M.composeWorkspaceCard(v, state, store);
        const stats = M.countCardWidgets(card);
        if (!stats.withinLimit) throw new Error(`Widget guard failed [${sc.id}/${v}/${host}/${label}]: ${JSON.stringify(stats)}`);
        if (state.lastSubmission) {
          const leaked = Object.keys(state.lastSubmission.submittedDocumentData).filter((k) => M.isSelectionKey(k));
          if (leaked.length) throw new Error(`Ephemeral keys leaked into onSubmit: ${leaked.join(', ')}`);
        }
      };
      check('initial');
      for (const step of sc.steps) {
        for (const evt of step.events || [step.event]) state = M.reduceUiProcessEvent(state, evt, store);
        check(step.label);
      }
    }
  }
}
console.log('Smoke check passed');
EOF
```

*Done when*: the command exits `0` with zero syntax errors, zero DOM globals, `withinLimit === true` across every scenario step × variant × host, and zero ephemeral key leaks.

### 4. Hand over & iterate

Surface `scratch/<name>.prototype.html` and highlight the Drive/Gmail host toggle, `?variant=` floating switcher (`←` / `→`), walkthrough tabs, and Contract Inspector.

*Done when*: the user has driven the scenarios and settled on a winning card layout and state contract.

### 5. Capture & clean up

Follow the capture rule in [SKILL.md](SKILL.md): fold validated state transitions, contracts, and card layouts into real `src/features/` and `SchemaDrivenUi` code; record the settled question and answer on the issue; commit `scratch/<name>.prototype.html` to a throwaway branch outside `main` and `develop`; and leave a context pointer to that branch on the implementation issue.

*Done when*: production code reflects the validated design, the throwaway branch preserves `scratch/<name>.prototype.html`, and the issue links to the answer and branch.

## Anti-patterns

- **Adding `Columns` to sidebar cards**: stack single-column widgets vertically instead (`countCardWidgets` enforces `disallowed.length === 0`).
- **Reading DOM globals inside `<script id="portable-prototype-module">`**: keep all DOM rendering inside `<script id="prototype-ui-shell">` so the logic lifts directly into `src/features/`.
- **Leaking `Select*` UI state into `Document.data`**: filter all ephemeral keys through `isSelectionKey` / `extractDocumentData` and pass them via execution context.
- **Cosmetic-only variants**: make `A`, `B`, and `C` disagree on section placement, control types, and collapse pinning rather than only copy or color.
