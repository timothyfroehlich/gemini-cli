# Compact Tool Display Mode with Pinned-Scroll

## Goal
Add a toggleable "compact mode" that does two things:
1. **Collapses tool calls** into single high-density lines between conversation messages. Read-only tools are grouped onto one line; edit/bash tools get individual lines with click-to-expand (alt buffer only).
2. **Pins the user's message to the top** after submission, so the response fills in underneath without scrolling. Once content reaches the bottom of the visible area, normal auto-scroll resumes.

## Prerequisite: Alternate Buffer Mode
Both features require alternate buffer mode (`ui.useAlternateBuffer: true`) because:
- Standard mode uses Ink's `<Static>` rendering — once items scroll up, they're immutable and can't be re-rendered or collapsed
- Mouse click-to-expand only works in alternate buffer (mouse events + `getBoundingBox()` hit-testing)
- The pinned-scroll behavior requires control over the `VirtualizedList` scroll anchor, which only exists in alternate buffer
- The `VirtualizedList`/`ScrollableList` supports dynamic re-rendering when expand/collapse state changes

## Architecture Overview

The minimum terminal width the CLI targets is **80 columns** (see `isNarrowWidth()` in `packages/cli/src/ui/utils/isNarrowWidth.ts`).

Tool categorization from Core (`packages/core/src/tools/tools.ts`):
- **Read-only kinds**: `Kind.Read`, `Kind.Search`, `Kind.Fetch` → these get **grouped** onto a single line
- **Mutator kinds**: `Kind.Edit`, `Kind.Delete`, `Kind.Move`, `Kind.Execute`, `Kind.Communicate` → these get **individual lines**, click-to-expand

---

## Part 1: Compact Tool Call Display

### Step 1: Add setting `ui.compactToolDisplay`
**File:** `packages/cli/src/config/settingsSchema.ts`

Add a boolean setting in the UI settings group:
- Key: `ui.compactToolDisplay`
- Type: boolean
- Default: false
- Label: "Compact Tool Display"
- Description: "Collapse tool calls to compact single-line summaries. Requires alternate screen buffer."
- requiresRestart: false

### Step 2: Create `useCompactToolDisplay` hook
**File (new):** `packages/cli/src/ui/hooks/useCompactToolDisplay.ts`

Simple hook that reads the setting via `useSettings()` and also checks `useAlternateBuffer()`. Returns `true` only if both are enabled — compact display requires alternate buffer.

```typescript
export const useCompactToolDisplay = (): boolean => {
  const settings = useSettings();
  const isAltBuffer = useAlternateBuffer();
  return isAltBuffer && settings.merged.ui.compactToolDisplay === true;
};
```

### Step 3: Create expanded state context
**File (new):** `packages/cli/src/ui/contexts/ExpandedToolCallsContext.tsx`

A context that tracks which tool calls (by `callId`) are expanded. This needs to be lifted above individual components because `VirtualizedList` unmounts/remounts items during scrolling — local `useState` would lose expand state.

```typescript
interface ExpandedToolCallsContextValue {
  isExpanded: (callId: string) => boolean;
  toggleExpanded: (callId: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
}
```

Provide this in `MainContent.tsx` wrapping the `ScrollableList`.

### Step 4: Create `CompactToolLine` component
**File (new):** `packages/cli/src/ui/components/messages/CompactToolLine.tsx`

A single-line compact tool display for **mutator tools** (edit, bash, etc.):

```
✓ EditFile src/main.ts — Updated import statement
◐ Shell npm test
✗ WriteFile config.json — Error: file not found
```

Structure:
- Reuses `ToolStatusIndicator` for the status icon (3 chars, already exists in `ToolShared.tsx`)
- Tool name + description truncated to 1 line via `wrap="truncate"`
- Box with `ref` for `useMouseClick()` hit-testing in alt buffer
- On click: calls `toggleExpanded(callId)` from context
- When expanded: renders the full existing `ToolMessage` component below
- For currently-executing tools: show the spinner on the compact line

Width budget at 80 cols: `3 (status) + 1 (space) + 76 (name + description)` — fits comfortably.

### Step 5: Create `CompactReadOnlyGroup` component
**File (new):** `packages/cli/src/ui/components/messages/CompactReadOnlyGroup.tsx`

Groups consecutive read-only tool calls into a single summary line:

```
✓ Read 3 files, Grep 2 searches, Glob 1 pattern
◐ Read src/app.ts, Grep "handleSubmit"
```

Logic:
- Receives an array of `IndividualToolCallDisplay[]` (all read-only)
- Groups by tool name, counts occurrences
- If all succeeded: single `✓` prefix with grouped summary
- If any executing: show spinner with the currently-running tool description
- If any errors: show `✗` with error details
- Not expandable (read-only results are low-value in compact mode)

### Step 6: Modify `ToolGroupMessage.tsx`
**File:** `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx`

This is the key integration point. When compact mode is active:

1. Import `useCompactToolDisplay()` hook
2. Partition `visibleToolCalls` into two arrays:
   - `readOnlyTools`: tools where `isReadOnly` is true (need to pass this through from core — see Step 6b)
   - `mutatorTools`: everything else
3. Render:
   - One `CompactReadOnlyGroup` for the read-only batch (if any)
   - Individual `CompactToolLine` for each mutator tool
4. Remove the heavy round-border box wrapping — compact mode uses minimal chrome (just left-margin indent with a thin line or subtle color)
5. Keep existing rendering when compact mode is off (no changes to current behavior)

**Step 6b: Pass `isReadOnly` through the display pipeline**

The `IndividualToolCallDisplay` type needs a new optional field:
- **File:** `packages/cli/src/ui/types.ts` — add `isReadOnly?: boolean` to `IndividualToolCallDisplay`
- **File:** `packages/cli/src/ui/hooks/toolMapping.ts` — in `mapToDisplay()`, extract `isReadOnly` from the `ToolCall` (available via `call.invocation?.tool?.isReadOnly` or from the tool's `Kind`)

Alternatively, we can infer read-only status from the tool display name using a simple lookup:
```typescript
const READ_ONLY_DISPLAY_NAMES = new Set([
  'ReadFile', 'ReadManyFiles', 'Grep', 'Glob', 'Ls',
  'WebSearch', 'WebFetch', 'GetInternalDocs',
]);
```
This avoids modifying core types and keeps the change contained in the CLI package.

### Step 7: Wire up context provider and keyboard shortcut
**Files:** `packages/cli/src/ui/components/MainContent.tsx`, `packages/cli/src/ui/AppContainer.tsx`, `packages/cli/src/ui/keyMatchers.ts`

1. Wrap `ScrollableList` with `ExpandedToolCallsProvider` in `MainContent.tsx`
2. Add keyboard command (e.g., `Ctrl+T` for "toggle compact") that calls `expandAll()`/`collapseAll()`
3. Register in `keyMatchers.ts`

---

## Part 2: Pinned-Scroll (User Message Stays at Top)

### Concept
After the user submits a message, instead of keeping the scroll anchored to the bottom (where the input was), scroll so the user's message is at the **top** of the viewport. As the model responds, text fills in underneath — the user reads it like a page, not a scrolling ticker.

Once the content grows past the viewport height, transition back to normal bottom-sticking behavior.

### Step 8: Add `pinnedScroll` mode to VirtualizedList
**File:** `packages/cli/src/ui/components/shared/VirtualizedList.tsx`

The VirtualizedList already tracks `isStickingToBottom` state. We need a new complementary mode: `isStickingToTop`.

Add to the ref API:
```typescript
scrollToIndex: (params: {
  index: number;
  viewOffset?: number;
  viewPosition?: number;  // 0 = top of viewport, 1 = bottom
}) => void;
```

`scrollToIndex` already exists — we use `viewPosition: 0` to pin an item to the top.

Key behavior change: when `isStickingToTop` is active, the scroll anchor stays fixed even as new content is added below. This is the **opposite** of `isStickingToBottom` (which chases new content). The existing auto-scroll logic (lines ~240-253 in VirtualizedList.tsx) adds a condition:

```typescript
// Existing: auto-scroll to bottom when list grows
if (listGrew && (isStickingToBottom || wasAtBottom)) {
  setScrollAnchor({ index: data.length - 1, offset: SCROLL_TO_ITEM_END });
}

// New: when sticking to top, DON'T auto-scroll — keep anchor fixed
// BUT: transition to bottom-sticking once content exceeds viewport
if (isStickingToTop && contentExceedsViewport) {
  setIsStickingToTop(false);
  setIsStickingToBottom(true);
}
```

### Step 9: Trigger pinned-scroll after user message submission
**File:** `packages/cli/src/ui/components/MainContent.tsx`

After a new user message appears in history (detected via `lastUserPromptIndex` change):
1. Find the index of the user's message in `virtualizedData`
2. Call `scrollableListRef.current.scrollToIndex({ index: userMessageIndex, viewPosition: 0 })`
3. Set `isStickingToTop = true` on the VirtualizedList

This should only happen when compact mode is enabled (the setting).

### Step 10: Detect viewport overflow and transition to auto-scroll
**File:** `packages/cli/src/ui/components/shared/VirtualizedList.tsx`

In the existing `useEffect` that handles auto-scrolling (the one watching `data.length`, `totalHeight`, `containerHeight`):

```typescript
if (isStickingToTop) {
  // Content is growing below the pinned message.
  // Check if the bottom of content has reached the bottom of the viewport.
  const currentScrollTop = computeScrollTop();
  const contentBottom = currentScrollTop + containerHeight;

  if (totalHeight > contentBottom) {
    // Content has overflowed the viewport — transition to normal scrolling
    setIsStickingToTop(false);
    setIsStickingToBottom(true);
    // Scroll to follow the new content at the bottom
    setScrollAnchor({ index: data.length - 1, offset: SCROLL_TO_ITEM_END });
  }
}
```

---

## Component Interaction Diagram

```
MainContent
  └── ExpandedToolCallsProvider (new)
       └── ScrollableList / VirtualizedList
            ├── HistoryItemDisplay
            │    └── ToolGroupMessage
            │         ├── [compact OFF] → ToolMessage / ShellToolMessage (existing, unchanged)
            │         └── [compact ON]
            │              ├── CompactReadOnlyGroup (new) — "✓ Read 3 files, Grep 2"
            │              └── CompactToolLine (new, per mutator tool)
            │                   ├── collapsed: single line (status + name + desc)
            │                   │    └── mouse click → toggleExpanded(callId)
            │                   └── expanded: full ToolMessage (existing, rendered below)
            └── Scroll behavior
                 ├── [compact OFF] → normal bottom-sticking (existing)
                 └── [compact ON]  → pinned-scroll after user message
                      └── transitions to bottom-sticking when content overflows viewport
```

## Edge Cases to Handle

1. **Currently executing tools** — Show spinner on compact line; auto-expand is NOT needed (user can click if curious)
2. **Tool confirmation queue** — Confirming tools are already filtered out by ToolGroupMessage; no change needed
3. **Shell tools with interactive focus** — When a shell tool is focused via `Ctrl+F`, it should auto-expand regardless of compact mode
4. **VirtualizedList remounting** — Expanded state is in context, survives unmount/remount
5. **Switching modes mid-session** — If user toggles setting, all tools re-render; expanded state can be preserved
6. **Rapid submissions** — If user sends another message while content is still sticking-to-top, the new message becomes the pinned item
7. **Manual scroll** — If user manually scrolls during pinned-scroll phase, cancel the pin (same as existing behavior for sticking-to-bottom)
8. **Standard (non-alt) buffer** — Both features are disabled; existing behavior is completely unchanged
9. **Narrow terminals (<80 cols)** — CompactToolLine should still work at 80 cols. The grouped read-only summary truncates gracefully with `wrap="truncate"`

## Files Changed Summary

| File | Type | Description |
|------|------|-------------|
| `packages/cli/src/config/settingsSchema.ts` | Modify | Add `ui.compactToolDisplay` setting |
| `packages/cli/src/ui/hooks/useCompactToolDisplay.ts` | New | Hook to read compact display setting |
| `packages/cli/src/ui/contexts/ExpandedToolCallsContext.tsx` | New | Context for per-tool expanded state |
| `packages/cli/src/ui/components/messages/CompactToolLine.tsx` | New | Single-line collapsed mutator tool display |
| `packages/cli/src/ui/components/messages/CompactReadOnlyGroup.tsx` | New | Grouped read-only tools summary line |
| `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx` | Modify | Partition tools, conditionally render compact vs full |
| `packages/cli/src/ui/types.ts` | Modify | Add `isReadOnly` to `IndividualToolCallDisplay` (optional) |
| `packages/cli/src/ui/components/MainContent.tsx` | Modify | Add ExpandedToolCallsProvider, trigger pinned-scroll |
| `packages/cli/src/ui/components/shared/VirtualizedList.tsx` | Modify | Add `isStickingToTop` mode, transition logic |
| `packages/cli/src/ui/AppContainer.tsx` | Modify | Wire up expand/collapse keyboard shortcut |
| `packages/cli/src/ui/keyMatchers.ts` | Modify | Add compact toggle command |

## Implementation Order

1. Steps 1-2: Setting + hook (foundation, no visible change)
2. Steps 4-5: CompactToolLine + CompactReadOnlyGroup components (can develop/test in isolation)
3. Steps 3, 6, 7: Context + ToolGroupMessage integration + keyboard shortcut (wires it all together)
4. Steps 8-10: Pinned-scroll behavior (independent from Part 1, can be developed in parallel)
