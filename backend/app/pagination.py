from collections.abc import Sequence
from math import ceil
from typing import Any

from pydantic import BaseModel, Field, model_validator


class PaginationMeta(BaseModel):
    """Offset-based pagination metadata."""

    page: int = Field(ge=1, default=1)
    per_page: int = Field(ge=1, le=100, default=20)
    total: int = Field(ge=0)
    total_pages: int = Field(ge=0, default=0)

    @model_validator(mode="after")
    def _compute_total_pages(self) -> "PaginationMeta":
        if self.per_page:
            self.total_pages = ceil(self.total / self.per_page)
        return self


def paginate(
    items: Sequence[Any],
    total: int,
    page: int = 1,
    per_page: int = 20,
) -> dict[str, Any]:
    """Build standard pagination envelope."""
    meta = PaginationMeta(page=page, per_page=per_page, total=total)
    return {
        "data": items,
        "meta": meta.model_dump(),
        "error": None,
    }
