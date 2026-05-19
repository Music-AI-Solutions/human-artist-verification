import hashlib
import hmac
import importlib
import importlib.util
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/worldid")
wallet_router = APIRouter(prefix="/wallet")
artist_router = APIRouter(prefix="/artist")
gated_router = APIRouter(prefix="/gated")

WORLD_ID_APP_ID = os.getenv("WORLD_ID_APP_ID", "app_xxxxx")
WORLD_ID_SIGNING_KEY = os.getenv("WORLD_ID_SIGNING_KEY", "secret_xxxxx")
WORLD_ID_VERIFY_URL = os.getenv(
    "WORLD_ID_VERIFY_URL",
    f"https://developer.worldcoin.org/api/v2/verify/{WORLD_ID_APP_ID}",
)
WORLD_ID_ACTION = os.getenv("WORLD_ID_ACTION", "verify-artist")
S3_SIGNING_SECRET = os.getenv("S3_SIGNING_SECRET", WORLD_ID_SIGNING_KEY)
DOWNLOAD_BASE_URL = os.getenv(
    "ATMOS_DOWNLOAD_BASE_URL",
    "https://downloads.example.com/atmos-master.wav",
)
DOWNLOAD_TTL_SECONDS = int(os.getenv("ATMOS_DOWNLOAD_TTL_SECONDS", "300"))
REQUEST_CONTEXT_TTL_SECONDS = int(os.getenv("WORLD_ID_CONTEXT_TTL_SECONDS", "600"))
DEMO_WALLET = "0x0000000000000000000000000000000000000a71"

_USED_NULLIFIERS: set[str] = set()
_VERIFIED_PROOFS: Dict[str, Dict[str, Any]] = {}
_WALLET_NONCES: Dict[str, str] = {}
_AUDIT_LOG: List[Dict[str, Any]] = []


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_wallet(wallet: str) -> str:
    return wallet.lower().strip()


def _hash_value(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _redis_client():
    redis_url = os.getenv("REDIS_URL")
    if not redis_url or importlib.util.find_spec("redis") is None:
        return None
    redis = importlib.import_module("redis")
    return redis.from_url(redis_url, decode_responses=True)


def is_nullifier_used(nullifier: str) -> bool:
    client = _redis_client()
    if client:
        return bool(client.sismember("worldid:nullifiers", nullifier))
    return nullifier in _USED_NULLIFIERS


def store_nullifier(nullifier: str) -> None:
    client = _redis_client()
    if client:
        client.sadd("worldid:nullifiers", nullifier)
        return
    _USED_NULLIFIERS.add(nullifier)


def log_event(
    event_type: str,
    wallet: Optional[str] = None,
    nullifier: Optional[str] = None,
    certificate: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    event = {
        "event_type": event_type,
        "wallet": _normalize_wallet(wallet) if wallet else None,
        "nullifier_hash": _hash_value(nullifier),
        "certificate_hash": _hash_value(certificate),
        "metadata": metadata or {},
        "created_at": _utc_now(),
    }
    _AUDIT_LOG.append(event)
    return event


class SignRequest(BaseModel):
    wallet: Optional[str] = None
    certificate: Optional[str] = None
    action: str = WORLD_ID_ACTION


class SignResponse(BaseModel):
    app_id: str
    action: str
    rp_context: str
    nonce: str
    expires_at: int


class WorldIdProof(BaseModel):
    merkle_root: str = Field(..., alias="merkle_root")
    nullifier_hash: str = Field(..., alias="nullifier_hash")
    proof: str
    verification_level: Optional[str] = Field(default=None, alias="verification_level")
    credential_type: Optional[str] = Field(default=None, alias="credential_type")
    action: str = WORLD_ID_ACTION
    signal: Optional[str] = None


class WalletVerifyRequest(BaseModel):
    wallet: str
    nonce: str
    signature: str


class ArtistOnboardRequest(BaseModel):
    proof: WorldIdProof
    wallet: str
    certificate: str


class VerificationResponse(BaseModel):
    verified: bool
    nullifier_hash: str
    result: Dict[str, Any]


class OnboardResponse(BaseModel):
    onboarded: bool
    wallet: str
    event: Dict[str, Any]


class GatedDownloadResponse(BaseModel):
    download_url: str
    expires_at: int


def _sign_context(payload: Dict[str, Any]) -> str:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    digest = hmac.new(
        WORLD_ID_SIGNING_KEY.encode("utf-8"), body.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"{body}.{digest}"


def _signed_download_url(owner: str, contract: str, token_id: str) -> GatedDownloadResponse:
    expires_at = int(time.time()) + DOWNLOAD_TTL_SECONDS
    payload = f"{owner}:{contract}:{token_id}:{expires_at}"
    signature = hmac.new(
        S3_SIGNING_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    query = urllib.parse.urlencode(
        {
            "owner": owner,
            "contract": contract,
            "token_id": token_id,
            "expires": expires_at,
            "signature": signature,
        }
    )
    separator = "&" if "?" in DOWNLOAD_BASE_URL else "?"
    return GatedDownloadResponse(
        download_url=f"{DOWNLOAD_BASE_URL}{separator}{query}",
        expires_at=expires_at,
    )


def _model_dump(model: BaseModel, **kwargs) -> Dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(**kwargs)
    return model.dict(**kwargs)


async def _verify_with_worldcoin(proof: WorldIdProof) -> Dict[str, Any]:
    if is_nullifier_used(proof.nullifier_hash):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="World ID nullifier has already been used.",
        )

    payload = _model_dump(proof, by_alias=True, exclude_none=True)
    payload["action"] = proof.action or WORLD_ID_ACTION

    if os.getenv("WORLD_ID_SKIP_REMOTE_VERIFY") == "true" or WORLD_ID_APP_ID == "app_xxxxx":
        return {"success": True, "mode": "local-demo"}

    request = urllib.request.Request(
        WORLD_ID_VERIFY_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8")
        try:
            parsed_error: Any = json.loads(error_body)
        except json.JSONDecodeError:
            parsed_error = error_body
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "World ID verification failed", "response": parsed_error},
        ) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"World ID verification request failed: {exc}",
        ) from exc
    if result.get("success") is False:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "World ID proof was rejected", "response": result},
        )
    return result


@router.post("/sign", response_model=SignResponse)
def sign_request(request: SignRequest) -> SignResponse:
    nonce = secrets.token_urlsafe(24)
    expires_at = int(time.time()) + REQUEST_CONTEXT_TTL_SECONDS
    payload = {
        "action": request.action,
        "wallet": _normalize_wallet(request.wallet) if request.wallet else None,
        "certificate_hash": _hash_value(request.certificate),
        "nonce": nonce,
        "expires_at": expires_at,
    }
    return SignResponse(
        app_id=WORLD_ID_APP_ID,
        action=request.action,
        rp_context=_sign_context(payload),
        nonce=nonce,
        expires_at=expires_at,
    )


@router.post("/verify", response_model=VerificationResponse)
async def verify_proof(proof: WorldIdProof) -> VerificationResponse:
    result = await _verify_with_worldcoin(proof)
    store_nullifier(proof.nullifier_hash)
    _VERIFIED_PROOFS[proof.nullifier_hash] = result
    log_event(
        "worldid_verify",
        nullifier=proof.nullifier_hash,
        metadata={"action": proof.action, "verification_result": result},
    )
    return VerificationResponse(verified=True, nullifier_hash=proof.nullifier_hash, result=result)


@wallet_router.post("/nonce")
def wallet_nonce(wallet: str = Query(...)) -> Dict[str, str]:
    normalized = _normalize_wallet(wallet)
    nonce = secrets.token_urlsafe(24)
    _WALLET_NONCES[normalized] = nonce
    return {"wallet": normalized, "nonce": nonce}


@wallet_router.post("/verify")
def verify_wallet_signature(request: WalletVerifyRequest) -> Dict[str, Any]:
    normalized = _normalize_wallet(request.wallet)
    expected_nonce = _WALLET_NONCES.get(normalized)
    if expected_nonce and not hmac.compare_digest(expected_nonce, request.nonce):
        raise HTTPException(status_code=400, detail="Wallet nonce does not match.")

    if normalized != DEMO_WALLET and len(request.signature) < 32:
        raise HTTPException(status_code=400, detail="Wallet signature is malformed.")

    _WALLET_NONCES.pop(normalized, None)
    log_event("wallet_verify", wallet=normalized, metadata={"nonce": request.nonce})
    return {"verified": True, "wallet": normalized}


@artist_router.post("/onboard", response_model=OnboardResponse)
async def onboard_artist(request: ArtistOnboardRequest) -> OnboardResponse:
    if request.proof.nullifier_hash in _VERIFIED_PROOFS:
        world_id = _VERIFIED_PROOFS[request.proof.nullifier_hash]
    else:
        world_id = await _verify_with_worldcoin(request.proof)
        store_nullifier(request.proof.nullifier_hash)
        _VERIFIED_PROOFS[request.proof.nullifier_hash] = world_id
    event = log_event(
        "artist_onboard",
        wallet=request.wallet,
        nullifier=request.proof.nullifier_hash,
        certificate=request.certificate,
        metadata={"world_id": world_id},
    )
    return OnboardResponse(onboarded=True, wallet=_normalize_wallet(request.wallet), event=event)


@gated_router.get("/download", response_model=GatedDownloadResponse)
def gated_download(owner: str, contract: str, token_id: str) -> GatedDownloadResponse:
    normalized_owner = _normalize_wallet(owner)
    contract_id = contract.lower().strip()
    if not normalized_owner or not contract_id or not token_id:
        raise HTTPException(status_code=400, detail="owner, contract, and token_id are required.")

    download = _signed_download_url(normalized_owner, contract_id, token_id)
    log_event(
        "gated_download",
        wallet=normalized_owner,
        metadata={"contract": contract_id, "token_id": token_id, "expires_at": download.expires_at},
    )
    return download


@gated_router.get("/download/redirect")
def gated_download_redirect(owner: str, contract: str, token_id: str) -> RedirectResponse:
    return RedirectResponse(gated_download(owner, contract, token_id).download_url)


@router.get("/audit")
def audit_log() -> Dict[str, Any]:
    return {"events": _AUDIT_LOG[-100:]}
