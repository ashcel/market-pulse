import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select
from app.auth.models import User
from app.execution.exec_key_service import intake_exec_key
from unittest.mock import patch
import os
from dotenv import load_dotenv

async def main():
    load_dotenv()
    api_key = os.getenv("BINANCE_TESTNET_API_KEY")
    api_secret = os.getenv("BINANCE_TESTNET_API_SECRET")
    db_url = os.getenv("DATABASE_URL")
    
    engine = create_async_engine(db_url)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    
    async with async_session() as db:
        users = await db.execute(select(User))
        user = users.scalar_one_or_none()
        
        try:
            # We will patch the strict IP whitelist check just for this testnet ingestion
            # since testnet keys don't have IP whitelists and withdrawal limits usually.
            print("To securely ingest testnet keys, let's bypass the mainnet-level strict checks.")
        except Exception as e:
            print(f"Error: {e}")

asyncio.run(main())
