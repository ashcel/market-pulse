Change the Trade Assistant overlay on the token page into a collapsible dock sidebar.

## CURRENT PROBLEM
AssistantPanel is positioned `lg:absolute lg:right-3 lg:z-30 lg:w-[320px]` floating over the chart with `bg-card/95 backdrop-blur-md` — it blocks the chart.

## LAYOUT CHANGE (token.$symbol.tsx)
Current structure around line 594-770:
```
<div class="relative flex flex-col ...">
  <div class="...">[Chart + footer]</div>
  <AssistantPanel class="w-full lg:absolute lg:right-3 lg:z-30 lg:w-[320px]" />
</div>
```

Change to:
```
<div class="flex flex-col lg:flex-row gap-3 lg:min-h-0 lg:flex-1">
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">[Chart + footer]</div>
  <AssistantPanel ... /> <!-- NOT absolute, part of flex row -->
</div>
```

## COLLAPSIBLE DOCK BEHAVIOR
In TokenDetailPage (token.$symbol.tsx):
- Add state: `const [assistantOpen, setAssistantOpen] = useState(true);`
- Pass as props to AssistantPanel: `open={assistantOpen} onToggle={() => setAssistantOpen(v => !v)}`

## ASSISTANTPANEL CHANGES (assistant-panel.tsx)
### When open={true}:
- Fixed width 320px sidebar in the flex row
- Header: "Trade Assistant" + collapse button (ChevronRight icon from lucide-react)
- Content: Execution Plan + evidence accordion (same as current)
- No absolute positioning, no z-index, no backdrop blur
- Full height of the flex container

### When open={false}:
- Collapse to a thin vertical tab ~36px wide on the right edge
- Vertical text "Trade Assistant" (use writing-mode: vertical-rl or similar)
- Expand button (ChevronLeft icon)
- Cursor-pointer to expand
- Fixed height matching the chart area

## RESPONSIVE
- Mobile (< lg): AssistantPanel stacks below chart (full width), always open
- Desktop (>= lg): Side-by-side layout with collapsible dock

## FILES TO MODIFY
- frontend/src/routes/token.$symbol.tsx
- frontend/src/components/features/token/assistant-panel.tsx

## CONSTRAINTS
- NO changes to hooks, data fetching, or backend
- NO git operations
- Tailwind v4 classes
- Use existing components (IqCard, Badge, Button, lucide-react icons)
- Keep existing props/functionality of AssistantPanel
