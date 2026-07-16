# Backend Conventions — Market Pulse

> Adapted from [zhanymkanov/fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices),
> selectively applied to our use case.

---

## Prinsip Arsitektur — SOLID · DRY · KISS · YAGNI

Setiap baris kode harus bisa dijelaskan dengan salah satu prinsip ini.

### SOLID (untuk Python/FastAPI)

| Huruf | Prinsip | Dalam Praktik |
|-------|---------|---------------|
| **S** | Single Responsibility | Satu service function = satu tanggung jawab. `sync_trades()` sync, `calculate_forensics()` hitung — jangan campur. |
| **O** | Open/Closed | Plugin pattern via dependency injection. Service terima DB session via parameter, bukan `import db` langsung. |
| **L** | Liskov Substitution | Interface konsisten — `BinanceProvider` dan `BybitProvider` harus bisa tukar tanpa ubah code consumer. |
| **I** | Interface Segregation | Dependency kecil spesifik > satu dependency besar. `get_db()` dan `get_current_user()` terpisah, bukan satu super-dep. |
| **D** | Dependency Inversion | Service layer gak boleh tau detail HTTP atau DB driver. Trade service panggil `TradeRepository`, bukan `session.execute()` langsung. |

**L — Liskov di Python:**
```python
# ✅ Interface konsisten: provider bisa ditukar
class ExchangeProvider(ABC):
    @abstractmethod
    async def fetch_klines(self, symbol: str, interval: str) -> list[Candle]: ...

class BinanceProvider(ExchangeProvider): ...
class BybitProvider(ExchangeProvider): ...

# Service gak peduli exchange mana yang dipake
async def analyze(symbol: str, provider: ExchangeProvider):
    candles = await provider.fetch_klines(symbol, "4H")
```

### DRY
```python
# ❌ Duplikasi — error handling yang sama di 3 endpoint
try:
    result = await service.do_something()
except ServiceError as e:
    return JSONResponse(status_code=400, content={"error": str(e)})

# ✅ Satu handler di global exception handlers
@app.exception_handler(ServiceError)
async def service_error_handler(request, exc):
    return JSONResponse(status_code=400, content={"error": str(exc)})
```

### KISS
```python
# ❌ Over-engineered — AbstractFactoryStrategyPattern untuk ambil data
class DataFetcherFactory:
    @staticmethod
    def create(source: str) -> AbstractDataFetcher: ...

# ✅ Simple — satu function, jelas tujuannya
async def fetch_data(symbol: str) -> Candle:
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"https://api.exchange.com/klines?symbol={symbol}")
        return parse_candles(resp.json())
```

### YAGNI
```python
# ❌ You Ain't Gonna Need It — generic multi-exchange abstraction di hari pertama
class UnifiedExchangeGateway:
    def __init__(self, providers: dict[str, BaseExchangeProvider]): ...

# ✅ Cukup Binance dulu. Tambah abstraction KALAU ada exchange kedua.
async def fetch_klines(symbol: str) -> list[Candle]:
    return await binance_client.fetch_klines(symbol, "4H")
```

**Iron rule:** tanya "do we need this TODAY?" sebelum nambah abstraksi apapun.

---

## Stack

| Layer | Pilihan | Versi Min | Notes |
|-------|---------|-----------|-------|
| Framework | **FastAPI** | 0.115 | `Annotated[T, Depends(...)]` idiomatic |
| ORM | **SQLAlchemy 2.0 async** | 2.0 | `AsyncSession`, `async_sessionmaker` |
| Migrations | **Alembic** | 1.13 | Async-aware, `-t async` |
| Validation | **Pydantic v2** | 2.7 | `@field_serializer`, no `json_encoders` |
| Config | **pydantic-settings** | 2.4 | Satu BaseSettings per domain |
| HTTP client | **httpx** | 0.27 | `ASGITransport` for tests |
| Auth | **PyJWT** | 2.9 | Bukan `python-jose` (unmaintained) |
| Workers | **arq** (Redis) | — | Cron + scheduled tasks |
| Linter | **Ruff** | 0.6 | Replace black + isort + flake8 |
| Type checker | **mypy** | — | Strict mode |
| Testing | **pytest** | — | `pytest-asyncio`, `httpx.AsyncClient` |
| Python | **3.12+** | 3.12 | Type parameter syntax, `StrEnum` |

---

## 1. Project Structure

Domain-based, bukan layer-based. Setiap domain punya paket sendiri.

```
backend/
├── app/
│   ├── main.py                 # FastAPI app, lifespan, CORS, mount routers
│   ├── config.py               # Global BaseSettings (DB, Redis, env)
│   ├── database.py             # Async engine + session factory
│   ├── exceptions.py           # Global exception handlers
│   ├── pagination.py           # Pagination utilities
│   │
│   ├── auth/                   # Domain: authentication
│   │   ├── router.py
│   │   ├── schemas.py          # Pydantic request/response models
│   │   ├── models.py           # SQLAlchemy models
│   │   ├── service.py          # Business logic
│   │   ├── dependencies.py     # Route dependencies (get_current_user, etc.)
│   │   ├── config.py           # Domain-specific BaseSettings (JWT, etc.)
│   │   ├── constants.py        # Error codes, enums
│   │   ├── exceptions.py       # Domain-specific exceptions
│   │   └── utils.py            # Helper functions
│   │
│   ├── market/                 # Domain: market data
│   │   ├── router.py
│   │   ├── schemas.py
│   │   ├── models.py
│   │   ├── service.py
│   │   ├── dependencies.py
│   │   ├── config.py
│   │   ├── constants.py
│   │   └── exceptions.py
│   │
│   ├── trades/                 # Domain: trade journal
│   │   ├── router.py
│   │   ├── schemas.py
│   │   ├── models.py
│   │   ├── service.py
│   │   ├── dependencies.py
│   │   ├── constants.py
│   │   └── exceptions.py
│   │
│   └── worker/                 # Domain: background jobs
│       ├── functions.py        # arq job functions
│       └── config.py           # Worker-specific settings
│
├── tests/
│   ├── conftest.py             # Global fixtures: test client, DB, auth
│   ├── test_auth/
│   ├── test_market/
│   └── test_trades/
│
├── alembic/
│   ├── env.py
│   └── versions/               # YYYY-MM-DD_descriptive_name.py
│
├── app.py                      # Entry point: uvicorn app.app:app
├── pyproject.toml
└── alembic.ini
```

### Cross-domain imports

```python
# ✅ Good — explicit module alias
from src.auth import constants as auth_constants
from src.market import service as market_service
from src.trades.constants import ErrorCode as TradesErrorCode

# ❌ Bad — deep path or wildcard
from src.auth.service.user import ...  # NO
from src.auth import *                  # NO
```

---

## 2. Async Routes

### Decision rule

| Route melakukan ini | Pakai |
|---------------------|-------|
| `await`-able non-blocking I/O | `async def` |
| Blocking I/O (no async client) | `def` (runs in threadpool) |
| Campuran keduanya | `async def` + `run_in_threadpool` untuk bagian blocking |
| CPU-bound (>50ms compute) | Offload ke worker (arq) |

```python
# ❌ DON'T — blocking call di async route → freeze event loop
@router.get("/bad")
async def bad():
    time.sleep(10)  # blocks ALL requests
    return {"ok": True}

# ✅ DO — sync route → threadpool
@router.get("/sync-ok")
def sync_ok():
    time.sleep(10)  # blocks one thread, not the loop
    return {"ok": True}

# ✅ DO — async route dengan awaitable
@router.get("/async-ok")
async def async_ok():
    await asyncio.sleep(10)  # yields control
    return {"ok": True}

# ✅ DO — async route, panggil sync library via threadpool
from fastapi.concurrency import run_in_threadpool

@router.get("/wrap")
async def wrap():
    result = await run_in_threadpool(legacy_sync_client.fetch, "id")
    return result
```

### Threadpool catatan
- Default threadpool size = 40. Saturasi → semua sync route lambat.
- Thread lebih mahal dari coroutine. Jangan pake sync route "just because."

---

## 3. Pydantic

### 3.1 Gunakan validators built-in

```python
from enum import StrEnum
from pydantic import AnyUrl, BaseModel, EmailStr, Field

class MusicBand(StrEnum):
    AEROSMITH = "AEROSMITH"
    QUEEN = "QUEEN"
    ACDC = "AC/DC"

class UserCreate(BaseModel):
    first_name: str = Field(min_length=1, max_length=128)
    username: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    email: EmailStr
    age: int = Field(ge=18)                  # required
    favorite_band: MusicBand | None = None
    website: AnyUrl | None = None
```

> Jangan `Field(ge=18, default=None)` — constraint dan default saling kontradiksi.
> Decide: required (`Field(ge=18)`) atau optional (`int | None = Field(default=None, ge=18)`).

### 3.2 Custom Base Model

```python
from datetime import datetime
from zoneinfo import ZoneInfo
from pydantic import BaseModel, ConfigDict, field_serializer

class CustomModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    @field_serializer("*", when_used="json", check_fields=False)
    def _serialize_datetimes(self, value):
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=ZoneInfo("UTC"))
            return value.strftime("%Y-%m-%dT%H:%M:%S%z")
        return value
```

### 3.3 Split BaseSettings per domain

```python
# app/auth/config.py
from datetime import timedelta
from pydantic_settings import BaseSettings, SettingsConfigDict

class AuthConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="AUTH_", env_file=".env", extra="ignore"
    )
    JWT_ALG: str
    JWT_SECRET: str
    JWT_EXP_MINUTES: int = 5
    REFRESH_TOKEN_KEY: str
    REFRESH_TOKEN_EXP: timedelta = timedelta(days=30)
    SECURE_COOKIES: bool = True

auth_settings = AuthConfig()

# app/config.py — global settings
from pydantic import PostgresDsn, RedisDsn
from pydantic_settings import BaseSettings

class Config(BaseSettings):
    DATABASE_URL: PostgresDsn
    REDIS_URL: RedisDsn
    SITE_DOMAIN: str = "iq.heydewi.com"
    ENVIRONMENT: str = "production"
    CORS_ORIGINS: list[str]
    APP_VERSION: str = "1.0"

settings = Config()
```

---

## 4. Dependencies

### 4.1 Gunakan `Annotated`, bukan default-arg `Depends`

```python
from typing import Annotated
from fastapi import Depends, Path

# ✅ Modern — Annotated form
PostDep = Annotated[dict, Depends(valid_post_id)]

@router.get("/posts/{post_id}")
async def get_post(post: PostDep):
    return post

# ❌ Avoid — legacy default-arg form
@router.get("/posts/{post_id}")
async def get_post(post: dict = Depends(valid_post_id)):
    return post
```

### 4.2 Validate inside dependencies

```python
async def valid_post_id(post_id: UUID4) -> dict:
    post = await service.get_by_id(post_id)
    if not post:
        raise PostNotFound()
    return post
```

### 4.3 Chain dependencies for reuse

```python
async def valid_owned_post(
    post: Annotated[dict, Depends(valid_post_id)],
    token_data: Annotated[dict, Depends(parse_jwt_data)],
) -> dict:
    if post["creator_id"] != token_data["user_id"]:
        raise UserNotOwner()
    return post
```

### 4.4 Rules
- Dependencies **di-cache per request**. `Depends(x)` dipanggil 5× dalam 1 request → `x` jalan sekali.
- Prefer `async def` dependencies. Sync deps jalan di threadpool — wasted overhead buat CPU-only checks.
- Gunakan **nama path variable yang sama** antar endpoint untuk share dependency (`profile_id` di `/profiles/{profile_id}` dan `/creators/{profile_id}`).

---

## 5. API Design

### 5.1 Versioning
```python
from fastapi import APIRouter

app = FastAPI(title="Market Pulse API", version="1.0")
v1_router = APIRouter(prefix="/api/v1")
app.mount("/api/v1", v1_router)
```

### 5.2 Standard response envelope
```python
# Success
{
  "data": { ... },
  "meta": { "page": 1, "per_page": 20, "total": 150 },
  "error": null
}

# Error
{
  "data": null,
  "meta": null,
  "error": {
    "code": "INVALID_SYMBOL",
    "message": "Symbol 'XYZ' not found",
    "details": { "symbol": "XYZ" }
  }
}
```

### 5.3 RESTful conventions
- Plural nouns: `/trades`, `/tokens`, `/api-keys`
- Nest by relationship: `/tokens/{symbol}/candles`
- Pagination: cursor-based for streams, offset-based for grids
- HTTP methods: GET (read), POST (create), PUT (full replace), PATCH (partial), DELETE (remove)

### 5.4 Document endpoints fully
```python
@router.post(
    "/trades",
    response_model=TradeResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Record a trade",
    description="Records a manually-entered trade in the journal.",
    tags=["trades"],
    responses={
        status.HTTP_400_BAD_REQUEST: {"model": ErrorResponse},
        status.HTTP_409_CONFLICT: {"model": ErrorResponse, "description": "Duplicate exchange_trade_id"},
    },
)
async def create_trade(payload: TradeCreate) -> TradeResponse: ...
```

### 5.5 Hide docs in production
```python
SHOW_DOCS_IN = {"local", "staging"}
app_kwargs = {"title": "Market Pulse API"}
if settings.ENVIRONMENT not in SHOW_DOCS_IN:
    app_kwargs["openapi_url"] = None  # disables /docs and /redoc

app = FastAPI(**app_kwargs)
```

---

## 6. Database

### 6.1 SQLAlchemy 2.0 async
```python
# app/database.py
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

engine = create_async_engine(str(settings.DATABASE_URL), pool_pre_ping=True)
SessionFactory = async_sessionmaker(engine, expire_on_commit=False)

async def get_db() -> AsyncSession:
    async with SessionFactory() as session:
        yield session
```

### 6.2 Naming conventions

| Element | Convention | Contoh |
|---------|------------|--------|
| Tables | `snake_case` plural | `trades`, `api_keys` |
| Columns | `snake_case` | `entry_price`, `opened_at` |
| Datetime | `_at` suffix | `created_at`, `closed_at` |
| Date | `_date` suffix | `settlement_date` |
| FK column | Sama di semua tabel | `user_id` everywhere, not `owner_id` in one table |
| PK | `id` | Always `id` |
| Indexes | Auto via naming convention | — |

### 6.3 Index naming convention
```python
from sqlalchemy import MetaData

POSTGRES_INDEXES_NAMING_CONVENTION = {
    "ix": "%(column_0_label)s_idx",
    "uq": "%(table_name)s_%(column_0_name)s_key",
    "ck": "%(table_name)s_%(constraint_name)s_check",
    "fk": "%(table_name)s_%(column_0_name)s_fkey",
    "pk": "%(table_name)s_pkey",
}
metadata = MetaData(naming_convention=POSTGRES_INDEXES_NAMING_CONVENTION)
```

### 6.4 SQL-first, Pydantic-second
- Joins, aggregation, JSON shaping → lakukan di SQL (Postgres lebih cepat dari CPython)
- Hydrate ke Pydantic hanya untuk response validation, bukan untuk transformasi
- Raw SQL hanya jika terbukti perlu — prefer ORM untuk 90% kasus

### 6.5 Kelas model
```python
from sqlalchemy.orm import Mapped, mapped_column, DeclarativeBase
from sqlalchemy import String, ForeignKey, Numeric

class Base(DeclarativeBase):
    metadata = metadata

class Trade(Base):
    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    symbol: Mapped[str] = mapped_column(String(20))
    entry_price: Mapped[float] = mapped_column(Numeric(20, 8))
    # ... explicit types everywhere
```

---

## 7. Authentication

### 7.1 JWT via PyJWT (bukan python-jose)
```python
import jwt  # PyJWT
from jwt.exceptions import InvalidTokenError

def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALG])
    except InvalidTokenError as exc:
        raise InvalidCredentials() from exc
```

### 7.2 Dependency injection
```python
from fastapi.security import OAuth2PasswordBearer
from typing import Annotated

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/token")

async def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)],
) -> User:
    payload = decode_token(token)
    user = await user_service.get_by_id(payload["sub"])
    if not user:
        raise InvalidCredentials()
    return user

CurrentUser = Annotated[User, Depends(get_current_user)]
```

---

## 8. Background Work

### Decision rule

| Pakai ini | Ketika |
|-----------|--------|
| **BackgroundTasks** | Task < 1 detik, failure bisa silent drop (send email, log) |
| **arq** (Redis) | Task > 1 detik, perlu retry, cron schedule, atau visibility |
| **Celery** | Hanya jika butuh fitur yang arq tidak punya (prefer arq dulu) |

```python
# BackgroundTasks — fire-and-forget, in-process
from fastapi import BackgroundTasks

@router.post("/signup")
async def signup(data: SignupIn, bg: BackgroundTasks):
    user = await service.create_user(data)
    bg.add_task(send_welcome_email, user.email)
    return user

# arq — cron schedule
# WorkerSettings dalam app/worker/config.py
from arq.connections import RedisSettings

class WorkerSettings:
    functions = [sync_trades, eval_pass, settle_pass]
    redis_settings = RedisSettings()
    keep_result = 300  # 5 minutes
```

> BackgroundTasks run **after response sent, di worker process yang sama**.
> Kalo worker mati, task hilang. Jangan untuk hal yang kamu akan page on.

---

## 9. Testing

### 9.1 Async client dari day one
```python
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

@pytest.mark.asyncio
async def test_create_trade(client: AsyncClient):
    resp = await client.post("/api/v1/trades", json={"symbol": "BTC"})
    assert resp.status_code == 201
```

### 9.2 Override dependencies, bukan mock internals
```python
from app.auth.dependencies import get_current_user
from app.main import app

def fake_user():
    return User(id="test-user-id", username="test")

@pytest.fixture(autouse=True)
def _override_auth():
    app.dependency_overrides[get_current_user] = fake_user
    yield
    app.dependency_overrides.clear()
```

### 9.3 Test structure
- Satu file per domain: `test_auth/`, `test_market/`, `test_trades/`
- `conftest.py` global: test client, DB session, auth override
- Integration tests pake real DB (testcontainers atau ephemeral schema)
- No mocks for exchange APIs — gunakan fixture data

---

## 10. Code Quality

### 10.1 pyproject.toml
```toml
[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "N", "W", "UP", "B", "SIM", "ARG", "RUF"]
ignore = []

[tool.mypy]
strict = true
python_version = "3.12"
disallow_untyped_defs = true
no_implicit_optional = true
warn_return_any = true
warn_unused_ignores = true

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

### 10.2 Pre-commit (lefthook)
```yaml
# lefthook.yml
pre-commit:
  parallel: true
  commands:
    lint:
      glob: "*.py"
      run: ruff check --fix {staged_files}
    format:
      glob: "*.py"
      run: ruff format {staged_files}
    type:
      glob: "*.py"
      run: mypy {staged_files}
    test:
      run: pytest -q --no-header --no-cov tests/
```

---

## 11. Engine Package (Standalone)

```
engine/
├── smc/
│   ├── __init__.py
│   ├── types.py          # Candle, PivotPoint, etc.
│   ├── analysis.py       # Swing, pivots
│   ├── structure.py      # Market structure, BOS
│   ├── liquidity.py      # Liquidity pools
│   ├── fvg.py            # Fair value gaps
│   ├── orderblocks.py    # Order blocks
│   ├── equilibrium.py    # Dealing range
│   ├── strength.py       # Swing strength
│   ├── objectives.py     # POI objectives
│   ├── quant.py          # evaluateSignal — the core
│   ├── market.py         # Orchestration
│   └── ...
├── tests/
│   ├── conftest.py
│   ├── dreimann/         # Ground-truth fixtures
│   ├── test_structure.py
│   └── ...
├── pyproject.toml
```

- **Zero framework dependency** — pure Python, no FastAPI, no SQLAlchemy
- Bisa pip-install ke backend atau dipake standalone
- Tests run dengan `pytest` saja — no database needed

---

## 12. Anti-Patterns Checklist

| Anti-pattern | Kenapa Salah | Fix |
|---|---|---|
| `requests.get()` di dalam `async def` | Block event loop. `requests` sync. | `httpx.AsyncClient` atau `run_in_threadpool` |
| `time.sleep` / `open()` / sync DB di `async def` | Block event loop. | `asyncio.sleep`, `aiofiles`, async driver |
| `from jose import jwt` | `python-jose` unmaintained. | `import jwt` (PyJWT) |
| `async_asgi_testclient` | Unmaintained. | `httpx.AsyncClient` + `ASGITransport` |
| `json_encoders` di Pydantic v2 | Deprecated. | `@field_serializer` |
| `Field(ge=18, default=None)` | Constraint kontradiksi default. | Pilih required atau optional |
| `def f(id: int = Depends(...))` | Legacy form. | `Annotated[int, Depends(...)]` |
| Catching `Exception` di route body | Sembunyiin bug. | Catch specific exception |
| `BackgroundTasks` untuk hal penting | No retry, dies with worker. | arq / Celery / RQ |
| Panggil sync ORM di `async def` | Block loop, deadlock pool. | `AsyncSession` |
| Mock database di integration tests | Mock/prod divergence. | Real DB + `dependency_overrides` |