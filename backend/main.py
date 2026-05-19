from fastapi import FastAPI
from routes import nft_art, splits, splits_verify, remaster, worldid

app = FastAPI(
    title="Human Artist Verification API",
    description="Backend for NFT Art, Split Sheets, Verification, and Dolby Atmos Remaster",
    version="1.0.0"
)

app.include_router(nft_art.router, tags=["NFT Art"])
app.include_router(splits.router, tags=["Splits"])
app.include_router(splits_verify.router, tags=["Verification"])
app.include_router(remaster.router, tags=["Remastering"])
app.include_router(worldid.router, tags=["World ID"])
app.include_router(worldid.wallet_router, tags=["Wallet"])
app.include_router(worldid.artist_router, tags=["Artist Onboarding"])
app.include_router(worldid.gated_router, tags=["Gated Downloads"])

@app.get("/")
def root():
    return {"message": "Human Artist Verification API is live"}
