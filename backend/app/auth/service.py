from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionFactory

from .exceptions import InvalidCredentialsError, UserExistsError
from .models import User
from .schemas import UserRegisterRequest
from .utils import create_access_token, hash_password, verify_password


async def register_user(
    payload: UserRegisterRequest, db: AsyncSession
) -> tuple[User, str]:
    result = await db.execute(select(User).where(User.email == payload.email))
    existing = result.scalar_one_or_none()
    if existing:
        raise UserExistsError(payload.email)

    user = User(
        email=payload.email,
        display_name=payload.display_name,
        hashed_password=hash_password(payload.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    token = create_access_token(user.id)
    return user, token


async def authenticate_user(
    email: str, password: str, db: AsyncSession
) -> tuple[User, str]:
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user or not verify_password(password, user.hashed_password):
        raise InvalidCredentialsError()

    token = create_access_token(user.id)
    return user, token


async def get_user_by_id(user_id: str) -> User | None:
    async with SessionFactory() as db:
        result = await db.execute(select(User).where(User.id == user_id))
        return result.scalar_one_or_none()
