# Frontend Conventions — Market Pulse

---

## Prinsip Arsitektur — SOLID · DRY · KISS · YAGNI

Setiap baris kode harus bisa dijelaskan dengan salah satu prinsip ini.

### SOLID (untuk React)

| Huruf | Prinsip               | Dalam Praktik                                                                                                                        |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **S** | Single Responsibility | Satu komponen = satu tanggung jawab. `TokenChart` render chart, `TradeForm` handle form — jangan campur.                             |
| **O** | Open/Closed           | Props + composition over inheritance. Komponen bisa diperluas via props, bukan di-edit isinya.                                       |
| **L** | Liskov Substitution   | Sebuah hook/component bisa diganti dengan implementasi lain tanpa merusak consumer. Gunakan interface yang konsisten.                |
| **I** | Interface Segregation | Props yang sedikit > props yang banyak. Jangan paksa consumer terima props yang gak dipake.                                          |
| **D** | Dependency Inversion  | Komponen gak boleh panggil API langsung — panggil hook/abstraction. `useTokenData()` bukan `fetch('/api/...')` langsung di komponen. |

### DRY

```tsx
// ❌ Duplikasi — enum yang sama ditulis ulang
// TokenCard.tsx, TradeFilter.tsx, Rankings.tsx — semuanya define sendiri
const TIMEFRAMES = ["15M", "1H", "4H", "1D"];

// ✅ Satu source of truth
import { TIMEFRAMES } from "@/lib/constants";
```

### KISS

```tsx
// ❌ Over-engineered
const displayPrice = useMemo(() => {
  return complexPriceFormatter(price, locale, options);
}, [price, locale, options]);

// ✅ Simple
const displayPrice = price.toFixed(2);
```

### YAGNI

```tsx
// ❌ You Ain't Gonna Need It — generic "any entity" table
function DataTable<T, K extends keyof T, V extends keyof T>(...){...}

// ✅ Specific, simple, dan langsung berguna
function TokenTable({ tokens }: { tokens: Token[] }){...}
```

**Iron rule:** tanya "do we need this TODAY?" sebelum nambah abstraksi apapun.

---

## 1. Data Fetching

### 1.1 Check cheap conditions before async

```tsx
// ❌ Bad — fetch then check
const { data } = useQuery(...);
if (!symbol) return null;

// ✅ Good — check before fetch
if (!symbol) return null;
const { data } = useQuery({
  queryKey: ['token', symbol],
  enabled: !!symbol,
});
```

### 1.2 Parallel independent fetches

```tsx
// ❌ Bad — sequential waterfall
const market = await fetchMarket();
const trades = await fetchTrades(); // waits for market

// ✅ Good — parallel
const [market, trades] = await Promise.all([fetchMarket(), fetchTrades()]);
```

### 1.3 TanStack Query for deduplication

```tsx
// TanStack Query auto-deduplicates concurrent requests for the same key
const { data } = useQuery({
  queryKey: ["token", symbol, timeframe],
  queryFn: () => fetchToken(symbol, timeframe),
  staleTime: 30_000, // 30s before refetch
});
```

---

## 2. Bundle Size

### 2.1 No barrel file imports

```tsx
// ❌ Bad — imports entire library
import { ChevronDown, ChevronUp, Search } from "lucide-react";

// ✅ Good — direct path imports
import ChevronDown from "lucide-react/icons/chevron-down";
import ChevronUp from "lucide-react/icons/chevron-up";
import Search from "lucide-react/icons/search";
```

### 2.2 Dynamic imports for heavy components

```tsx
import { lazy, Suspense } from "react";

// Heavy chart library — loaded on demand
const PriceChart = lazy(() => import("./PriceChart"));

<Suspense fallback={<ChartSkeleton />}>{showChart && <PriceChart data={data} />}</Suspense>;
```

---

## 3. Component Design

### 3.1 Don't define components inside components

```tsx
// ❌ Bad — re-creates on every render
function Parent() {
  function Child() {
    return <div />;
  }
  return <Child />;
}

// ✅ Good — hoist to module level
function Child() {
  return <div />;
}
function Parent() {
  return <Child />;
}
```

### 3.2 Extract memoized components for pure renders

```tsx
const TokenCard = memo(function TokenCard({ symbol, price }: Props) {
  return (
    <div>
      {symbol}: ${price}
    </div>
  );
});
```

### 3.3 Put interaction logic in event handlers, not effects

```tsx
// ❌ Bad — effect for user interaction
useEffect(() => {
  setFiltered(filter(items, search));
}, [search]);

// ✅ Good — event handler
function handleSearch(e: ChangeEvent<HTMLInputElement>) {
  setSearch(e.target.value);
  setFiltered(filter(items, e.target.value));
}
```

### 3.4 Hoist static JSX outside component

```tsx
// Static — never changes, define once
const EMPTY_STATE = <EmptyState message="No trades yet" />;

function TradeList() {
  if (trades.length === 0) return EMPTY_STATE;
  return <div>{trades.map(renderTrade)}</div>;
}
```

---

## 4. State Management

### 4.1 Calculate derived state during rendering (not effects)

```tsx
// ❌ Bad — effect for derived state
const [total, setTotal] = useState(0);
useEffect(() => setTotal(items.reduce(sum, 0)), [items]);

// ✅ Good — compute during render
const total = useMemo(() => items.reduce(sum, 0), [items]);
```

### 4.2 Functional setState updates

```tsx
// ✅ Good — prevents stale closure bugs
setCount((prev) => prev + 1);
```

### 4.3 Lazy state initialization

```tsx
// ✅ Good — expensive computation only runs once
const [data] = useState(() => parseHeavyData(raw));
```

### 4.4 useTransition for non-urgent updates

```tsx
const [isPending, startTransition] = useTransition();

function handleSearch(e) {
  startTransition(() => {
    setSearch(e.target.value); // don't block UI
  });
}
```

### 4.5 useRef for transient values (not state)

```tsx
// ✅ Good — doesn't cause re-render
const wsRef = useRef<WebSocket | null>(null);
```

---

## 5. Rendering

### 5.1 Explicit conditional rendering

```tsx
// ❌ Bad — 0 renders as "0"
{
  count && <Badge>{count}</Badge>;
}

// ✅ Good — explicit
{
  count > 0 && <Badge>{count}</Badge>;
}
// or ternary
{
  items.length > 0 ? <List items={items} /> : <Empty />;
}
```

### 5.2 Narrow effect dependencies

```tsx
// ❌ Bad — effect depends on entire object
useEffect(() => {
  connect(socket);
}, [socketConfig]);

// ✅ Good — depends only on what's actually used
useEffect(() => {
  connect(url);
}, [url]);
```

---

## 6. Performance

### 6.1 Build index maps for O(1) lookups

```tsx
// ❌ Bad — O(n) on every render
const asset = assets.find((a) => a.symbol === symbol);

// ✅ Good — build lookup once
const assetMap = useMemo(() => new Map(assets.map((a) => [a.symbol, a])), [assets]);
const asset = assetMap.get(symbol);
```

### 6.2 Use Set for membership checks

```tsx
const watchlist = useMemo(() => new Set(watchedSymbols), [watchedSymbols]);
const isWatched = watchlist.has(symbol);
```

### 6.3 Use toSorted() / toReversed() — never mutate

```tsx
// ❌ Bad — mutates original array
items.sort((a, b) => a.price - b.price);

// ✅ Good — returns new array
const sorted = items.toSorted((a, b) => a.price - b.price);
```

### 6.4 Combine multiple array iterations

```tsx
// ❌ Bad — three passes
const active = items.filter((x) => x.active);
const names = active.map((x) => x.name);
const total = active.reduce((s, x) => s + x.value, 0);

// ✅ Good — single pass
let total = 0;
const names: string[] = [];
for (const x of items) {
  if (x.active) {
    names.push(x.name);
    total += x.value;
  }
}
```

### 6.5 Early return / guard clauses

```tsx
function TradeBadge({ trade }) {
  if (!trade) return null;
  if (trade.status === "open") return <OpenBadge />;
  // ... main logic
}
```

### 6.6 No layout thrashing

```tsx
// ❌ Bad — interleaved reads/writes
element.style.width = "100px";
const height = element.offsetHeight;
element.style.height = `${height * 2}px`;

// ✅ Good — batch reads, then writes
const height = element.offsetHeight;
element.style.width = "100px";
element.style.height = `${height * 2}px`;
```

---

## 7. File Organization

### Folder structure

```
frontend/src/
├── components/       # Shared UI components (shadcn/ui + custom)
│   ├── ui/           # shadcn/ui primitives
│   └── features/     # Domain-specific components
├── hooks/            # Custom hooks
├── lib/              # Utilities, API client, types
│   ├── api/          # FastAPI client functions
│   ├── types/        # TypeScript types matching backend
│   └── utils/        # Pure utility functions
├── pages/            # Route pages (React Router)
└── main.tsx          # Entry point
```

### Naming rules

- **Components:** PascalCase, one component per file
- **Hooks:** `use*` prefix, camelCase
- **Utilities:** camelCase, pure functions
- **Types/interfaces:** PascalCase, exported
- **Files:** kebab-case for utilities, PascalCase for components
- **CSS:** Tailwind utility classes only — no CSS modules, no styled-components
