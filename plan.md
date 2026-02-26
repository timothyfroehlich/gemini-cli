# Expandable Tool Calls Display Mode

## Goal
Add a compact display mode for Gemini CLI where tool calls are collapsed to single lines by default, with click-to-expand support. This focuses the user on agent responses without tool call noise.

## Prerequisite: Alternate Buffer Mode
This feature **requires** alternate buffer mode (`ui.useAlternateBuffer: true`) because:
- Standard mode uses Ink's `<Static>` rendering — once items scroll up, they're immutable and can't be re-rendered
- Mouse events are only enabled in alternate buffer mode
- `getBoundingBox()` hit-testing only works on actively-rendered components
- The `VirtualizedList`/`ScrollableList` in alternate buffer mode supports dynamic re-rendering when expand/collapse state changes

## Implementation Steps

### Step 1: Add setting `ui.compactToolDisplay`
**File:** `packages/cli/src/config/settingsSchema.ts`

Add a boolean setting in the UI settings group:
- Key: `ui.compactToolDisplay`
- Type: boolean
- Default: false
- Label: "Compact Tool Display"
- Description: "Collapse tool calls to single lines. Click to expand. Requires alternate screen buffer."
- requiresRestart: false

### Step 2: Create `useCompactToolDisplay` hook
**File (new):** `packages/cli/src/ui/hooks/useCompactToolDisplay.ts`

Simple hook that reads the setting via `useSettings()` and also checks `useAlternateBuffer()`. Returns `true` only if both are enabled — compact display makes no sense without alternate buffer.

### Step 3: Create expanded state context
**File (new):** `packages/cli/src/ui/contexts/ExpandedToolCallsContext.tsx`

A context that tracks which tool calls (by `callId`) are expanded. This needs to be lifted above individual components because `VirtualizedList` unmounts/remounts items during scrolling — local `useState` would lose expand state.

Interface:
```typescript
interface ExpandedToolCallsContextValue {
  isExpanded: (callId: string) => boolean;
  toggleExpanded: (callId: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
}
```

Provide this in `AppContainer.tsx` or `MainContent.tsx`.

### Step 4: Create `CompactToolMessage` component
**File (new):** `packages/cli/src/ui/components/messages/CompactToolMessage.tsx`

A single-line tool call display:
```
✓ ReadFile src/main.ts (15 lines)
◐ Shell npm test
✗ EditFile config.json — Error: file not found
```

Structure:
- Uses existing `ToolStatusIndicator` for the status icon (already 3 chars wide)
- Uses existing `ToolInfo` for name + description (already truncates to 1 line with `height={1}`)
- Wraps in a `Box` with `ref` for `useMouseClick()` hit-testing
- On click: calls `toggleExpanded(callId)` from context
- When expanded: renders the full existing `ToolMessage` component below the compact line (or replaces it)

For currently-executing tools: show the compact line with the spinner, auto-expand if desired.

### Step 5: Modify `ToolGroupMessage.tsx`
**File:** `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx`

- Import `useCompactToolDisplay()` hook
- When compact mode is active:
  - Replace the per-tool rendering loop to use `CompactToolMessage` instead of `ToolMessage`/`ShellToolMessage`
  - Simplify border rendering (lighter borders or remove the heavy round-border box)
  - Keep the overflow/ShowMoreLines logic

The key change is in the `visibleToolCalls.map(...)` section (~line 223), where we conditionally render `CompactToolMessage` vs the existing components.

### Step 6: Wire up context provider
**File:** `packages/cli/src/ui/components/MainContent.tsx` (or `AppContainer.tsx`)

Wrap the relevant tree with `ExpandedToolCallsProvider`. This should be placed inside the existing provider hierarchy, ideally near where `MainContent` renders history items.

### Step 7: Add keyboard shortcut for expand/collapse all
**File:** `packages/cli/src/ui/AppContainer.tsx` + `packages/cli/src/ui/keyMatchers.ts`

Add a keybinding (e.g., `Ctrl+E` or similar) that calls `expandAll()`/`collapseAll()` to toggle all tool calls at once. This provides a keyboard-only path alongside mouse clicks.

## Component Interaction Diagram

```
MainContent
  └── ExpandedToolCallsProvider (new)
       └── ToolGroupMessage
            ├── [compact mode OFF] → ToolMessage / ShellToolMessage (existing)
            └── [compact mode ON]  → CompactToolMessage (new)
                 ├── collapsed: single line (ToolStatusIndicator + ToolInfo)
                 │    └── useMouseClick → toggleExpanded(callId)
                 └── expanded: full ToolMessage (existing, rendered below)
```

## Edge Cases to Handle
1. **Currently executing tools** — Show spinner on compact line; consider auto-expanding
2. **Tool confirmation queue** — Confirming tools are already filtered out by ToolGroupMessage; no change needed
3. **Shell tools with interactive focus** — When a shell tool is focused, it should auto-expand regardless of compact mode
4. **VirtualizedList remounting** — Expanded state is in context, survives unmount/remount
5. **Switching modes mid-session** — If user toggles the setting, all tools should re-render in the new mode; expanded state can be preserved or cleared

## Files Changed Summary
| File | Type | Description |
|------|------|-------------|
| `packages/cli/src/config/settingsSchema.ts` | Modify | Add `ui.compactToolDisplay` setting |
| `packages/cli/src/ui/hooks/useCompactToolDisplay.ts` | New | Hook to read compact display setting |
| `packages/cli/src/ui/contexts/ExpandedToolCallsContext.tsx` | New | Context for per-tool expanded state |
| `packages/cli/src/ui/components/messages/CompactToolMessage.tsx` | New | Single-line collapsed tool display |
| `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx` | Modify | Conditionally render compact vs full |
| `packages/cli/src/ui/components/MainContent.tsx` | Modify | Add ExpandedToolCallsProvider |
| `packages/cli/src/ui/AppContainer.tsx` | Modify | Wire up expand/collapse keyboard shortcut |
| `packages/cli/src/ui/keyMatchers.ts` | Modify | Add expand/collapse command |
