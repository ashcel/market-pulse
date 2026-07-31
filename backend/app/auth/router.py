from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, Field

from .dependencies import CurrentUserId, DbSession
from .schemas import (
    AuthResponse,
    OkEnvelope,
    OkResponse,
    PasswordChangeRequest,
    TokenEnvelope,
    TokenResponse,
    UserLoginRequest,
    UserRegisterRequest,
    UserResponse,
)
from .service import authenticate_user, change_password, register_user
from .telegram import login_with_init_data

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post(
    "/register",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new user",
)
async def register(
    payload: UserRegisterRequest,
    db: DbSession,
) -> AuthResponse:
    user, _ = await register_user(payload, db)
    return AuthResponse(
        data=UserResponse(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            created_at=user.created_at,
        )
    )


@router.post(
    "/login",
    response_model=TokenEnvelope,
    summary="Login and receive access token",
)
async def login(
    payload: UserLoginRequest,
    db: DbSession,
) -> TokenEnvelope:
    _, token = await authenticate_user(payload.email, payload.password, db)
    return TokenEnvelope(data=TokenResponse(access_token=token))


class TelegramLoginRequest(BaseModel):
    # Telegram's own field name is `initData`; accept it on the wire while
    # keeping the Python attribute snake_case.
    model_config = ConfigDict(populate_by_name=True)

    init_data: str = Field(min_length=1, max_length=8192, alias="initData")


class TelegramLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    email: str
    telegram_first_name: str | None = None


class TelegramLoginEnvelope(BaseModel):
    data: TelegramLoginResponse
    meta: None = None
    error: None = None


@router.post(
    "/telegram",
    response_model=TelegramLoginEnvelope,
    summary="Login from a Telegram Mini App with signed initData",
)
async def telegram_login(
    payload: TelegramLoginRequest,
    db: DbSession,
) -> TelegramLoginEnvelope:
    user, token, tg_user = await login_with_init_data(payload.init_data, db)
    first_name = tg_user.get("first_name") if tg_user else None
    return TelegramLoginEnvelope(
        data=TelegramLoginResponse(
            access_token=token,
            user_id=str(user.id),
            email=user.email,
            telegram_first_name=str(first_name) if first_name else None,
        )
    )


@router.post(
    "/change-password",
    response_model=OkEnvelope,
    summary="Change the current user's password",
)
async def change_password_endpoint(
    payload: PasswordChangeRequest,
    user_id: CurrentUserId,
    db: DbSession,
) -> OkEnvelope:
    await change_password(user_id, payload.current_password, payload.new_password, db)
    return OkEnvelope(data=OkResponse())


@router.get(
    "/me",
    response_model=AuthResponse,
    summary="Get current user profile",
)
async def me(
    user_id: CurrentUserId,
) -> AuthResponse:
    from .service import get_user_by_id  # avoid circular

    user = await get_user_by_id(user_id)
    assert user is not None  # guaranteed by auth dep
    return AuthResponse(
        data=UserResponse(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            created_at=user.created_at,
        )
    )
