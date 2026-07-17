
from fastapi import APIRouter, status

from .dependencies import CurrentUserId, DbSession
from .schemas import (
    AuthResponse,
    TokenEnvelope,
    TokenResponse,
    UserLoginRequest,
    UserRegisterRequest,
    UserResponse,
)
from .service import authenticate_user, register_user

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
