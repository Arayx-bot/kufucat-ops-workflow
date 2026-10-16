"""Minimal KIE.ai video adapter with cost guards and local task tracking.

The first supported provider/model is KIE.ai Grok Imagine text-to-video. The
public ``generate_video`` signature is intentionally provider-neutral so a
router can be added later without changing callers.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


API_BASE = "https://api.kie.ai"
MODEL = "grok-imagine/text-to-video"
IMAGE_TO_VIDEO_MODEL = "grok-imagine/image-to-video"
UPLOAD_BASE = "https://kieai.redpandaai.co"
UPLOAD_PATH = "/api/file-base64-upload"
CREATE_PATH = "/api/v1/jobs/createTask"
STATUS_PATH = "/api/v1/jobs/recordInfo"
CREDIT_PATH = "/api/v1/chat/credit"

QUALITY_CONFIG = {
    "low": ("480p", 0.012),
    "480p": ("480p", 0.012),
    "standard": ("720p", 0.0225),
    "high": ("720p", 0.0225),
    "720p": ("720p", 0.0225),
}
BUDGET_LIMITS_USD = {"low": 0.10, "medium": 0.50, "high": 2.00}
VALID_ASPECT_RATIOS = {"1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"}
VALID_CONSISTENCY = {"low", "medium", "high"}
TERMINAL_STATES = {"success", "fail"}


class KieVideoError(RuntimeError):
    """A safe-to-display KIE integration error (never includes the API key)."""


@dataclass(frozen=True)
class VideoGenerationResult:
    provider: str
    model: str
    task_id: str
    status: str
    estimated_cost_usd: float
    actual_cost_usd: float | None
    actual_credits: float | None
    output_path: str | None
    created_at: str
    completed_at: str | None
    failure_code: str | None = None
    failure_message: str | None = None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _project_root() -> Path:
    return Path(os.environ["KUFUCAT_PROJECT_ROOT"]).expanduser().resolve() if os.environ.get("KUFUCAT_PROJECT_ROOT") else Path(__file__).resolve().parents[3]


def _load_project_env(path: Path) -> None:
    """Load simple KEY=VALUE entries without printing or returning secrets."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _budget_limit(budget: str | float | int) -> float:
    if isinstance(budget, str):
        normalized = budget.strip().lower()
        if normalized in BUDGET_LIMITS_USD:
            return BUDGET_LIMITS_USD[normalized]
        try:
            return float(normalized)
        except ValueError as exc:
            raise ValueError("budget must be low/medium/high or a USD number") from exc
    return float(budget)


def _parse_embedded_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


class KieVideoAdapter:
    def __init__(
        self,
        api_key: str,
        *,
        runtime_dir: Path | None = None,
        output_dir: Path | None = None,
        api_base: str = API_BASE,
        request_timeout: int = 60,
    ) -> None:
        if not api_key or not api_key.strip():
            raise KieVideoError(
                "KIE_API_KEY is missing. Put it in the project-root .env file; do not paste it into chat."
            )
        self._api_key = api_key.strip()
        root = _project_root()
        self.runtime_dir = runtime_dir or root / "03-asset-center/.runtime/kie-video"
        self.output_dir = output_dir or root / "03-asset-center/outputs/TASK-KIE-API-001/v0.1/test-run"
        self.api_base = api_base.rstrip("/")
        self.request_timeout = request_timeout

    @classmethod
    def from_project_env(cls) -> "KieVideoAdapter":
        root = _project_root()
        _load_project_env(root / ".env")
        return cls(os.environ.get("KIE_API_KEY", ""))

    def estimate_cost(self, duration: int, quality: str) -> float:
        quality_key = quality.strip().lower()
        if quality_key not in QUALITY_CONFIG:
            raise ValueError("quality must be low, standard, high, 480p, or 720p")
        if not isinstance(duration, int) or duration <= 0:
            raise ValueError("duration must be a positive integer number of seconds")
        return round(duration * QUALITY_CONFIG[quality_key][1], 6)

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        api_base: str | None = None,
    ) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{(api_base or self.api_base).rstrip('/')}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Kufucat-KIE-Adapter/0.1",
            },
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.request_timeout, context=ssl.create_default_context()
            ) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            raise KieVideoError(f"KIE API HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise KieVideoError(f"KIE API connection failed: {exc.reason}") from exc
        try:
            result = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise KieVideoError("KIE API returned invalid JSON") from exc
        if not isinstance(result, dict):
            raise KieVideoError("KIE API returned an unexpected response")
        if result.get("code") not in (None, 200):
            raise KieVideoError(f"KIE API error {result.get('code')}: {result.get('msg', 'unknown error')}")
        return result

    def get_credit_balance(self) -> float | None:
        response = self._request_json("GET", CREDIT_PATH)
        value = response.get("data")
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def create_task(
        self,
        *,
        prompt: str,
        duration: int,
        aspect_ratio: str,
        resolution: str,
        model: str = MODEL,
        image_urls: list[str] | None = None,
    ) -> str:
        task_input: dict[str, Any] = {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "mode": "normal",
            "duration": str(duration),
            "resolution": resolution,
        }
        if image_urls:
            task_input["image_urls"] = image_urls
        response = self._request_json(
            "POST",
            CREATE_PATH,
            payload={
                "model": model,
                "input": task_input,
            },
        )
        data = response.get("data") or {}
        task_id = data.get("taskId") if isinstance(data, dict) else None
        if not task_id:
            raise KieVideoError("KIE accepted the request but did not return a taskId")
        return str(task_id)

    def upload_reference_image(self, image_path: str | Path) -> str:
        """Upload a temporary reference image without exposing the API key."""
        source = Path(image_path)
        if not source.is_file():
            raise ValueError(f"reference image does not exist: {source}")
        mime_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        encoded = base64.b64encode(source.read_bytes()).decode("ascii")
        response = self._request_json(
            "POST",
            UPLOAD_PATH,
            api_base=UPLOAD_BASE,
            payload={
                "base64Data": f"data:{mime_type};base64,{encoded}",
                "uploadPath": "kufucat/sm-001/d-reference",
                "fileName": source.name,
            },
        )
        data = response.get("data") or {}
        download_url = data.get("downloadUrl") if isinstance(data, dict) else None
        if not download_url:
            raise KieVideoError("KIE uploaded the reference image but returned no download URL")
        return str(download_url)

    def get_task(self, task_id: str) -> dict[str, Any]:
        query = urllib.parse.urlencode({"taskId": task_id})
        response = self._request_json("GET", f"{STATUS_PATH}?{query}")
        data = response.get("data")
        if not isinstance(data, dict):
            raise KieVideoError("KIE task response did not contain task data")
        return data

    def wait_for_task(self, task_id: str, *, timeout_seconds: int = 900) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        interval = 3.0
        while True:
            task = self.get_task(task_id)
            state = str(task.get("state", "unknown")).lower()
            if state in TERMINAL_STATES:
                return task
            if time.monotonic() >= deadline:
                raise KieVideoError(f"KIE task {task_id} timed out after {timeout_seconds} seconds")
            time.sleep(interval)
            interval = min(15.0, interval * 1.5)

    def _download(self, url: str, task_id: str) -> Path:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        safe_task = re.sub(r"[^A-Za-z0-9_-]", "_", task_id)[:80]
        destination = self.output_dir / f"kie-grok-test-{safe_task}.mp4"
        partial = destination.with_suffix(".mp4.part")
        request = urllib.request.Request(url, headers={"User-Agent": "Kufucat-KIE-Adapter/0.1"})
        try:
            with urllib.request.urlopen(request, timeout=180, context=ssl.create_default_context()) as response:
                with partial.open("wb") as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
            partial.replace(destination)
        except Exception:
            partial.unlink(missing_ok=True)
            raise
        return destination

    def _record(self, record: dict[str, Any]) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        ledger = self.runtime_dir / "tasks.jsonl"
        with ledger.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        task_id = record.get("task_id")
        if task_id:
            safe_task = re.sub(r"[^A-Za-z0-9_-]", "_", str(task_id))[:80]
            detail_path = self.runtime_dir / f"task-{safe_task}.json"
            detail_path.write_text(
                json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )

    def generate_video(
        self,
        prompt: str,
        duration: int,
        aspect_ratio: str,
        quality: str,
        budget: str | float | int,
        consistency_priority: str,
    ) -> VideoGenerationResult:
        prompt = prompt.strip()
        if not prompt:
            raise ValueError("prompt must not be empty")
        if aspect_ratio not in VALID_ASPECT_RATIOS:
            raise ValueError(f"unsupported aspect_ratio: {aspect_ratio}")
        consistency = consistency_priority.strip().lower()
        if consistency not in VALID_CONSISTENCY:
            raise ValueError("consistency_priority must be low, medium, or high")
        quality_key = quality.strip().lower()
        if quality_key not in QUALITY_CONFIG:
            raise ValueError("quality must be low, standard, high, 480p, or 720p")
        resolution, _ = QUALITY_CONFIG[quality_key]
        estimated_cost = self.estimate_cost(duration, quality_key)
        limit = _budget_limit(budget)
        if limit <= 0:
            raise ValueError("budget must be greater than zero")
        if estimated_cost > limit:
            raise KieVideoError(
                f"Cost guard blocked task: estimated ${estimated_cost:.4f} exceeds ${limit:.4f} budget"
            )

        created_at = _utc_now()
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        balance_before = self.get_credit_balance()
        task_id = self.create_task(
            prompt=prompt,
            duration=duration,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
        )
        submitted_record = {
            "event": "submitted",
            "provider": "kie.ai",
            "model": MODEL,
            "task_id": task_id,
            "status": "submitted",
            "created_at": created_at,
            "prompt_sha256": prompt_hash,
            "duration_seconds": duration,
            "aspect_ratio": aspect_ratio,
            "quality": quality_key,
            "resolution": resolution,
            "budget_limit_usd": limit,
            "consistency_priority": consistency,
            "estimated_cost_usd": estimated_cost,
            "credit_balance_before": balance_before,
            "actual_cost_usd": None,
            "actual_credits": None,
            "output_path": None,
        }
        self._record(submitted_record)

        task = self.wait_for_task(task_id)
        state = str(task.get("state", "unknown")).lower()
        balance_after = self.get_credit_balance()
        consumed_value = task.get("creditsConsumed")
        try:
            actual_credits = float(consumed_value) if consumed_value is not None else None
        except (TypeError, ValueError):
            actual_credits = None
        balance_delta = None
        if balance_before is not None and balance_after is not None:
            balance_delta = round(balance_before - balance_after, 6)
        if actual_credits is None and balance_delta is not None:
            actual_credits = balance_delta

        output_path: Path | None = None
        failure_code = None
        failure_message = None
        actual_cost_usd: float | None = None
        if state == "success":
            result_json = _parse_embedded_json(task.get("resultJson"))
            urls = result_json.get("resultUrls") or []
            if not isinstance(urls, list) or not urls:
                raise KieVideoError(f"KIE task {task_id} succeeded but returned no video URL")
            output_path = self._download(str(urls[0]), task_id)
            actual_cost_usd = estimated_cost
        else:
            failure_code = str(task.get("failCode") or "") or None
            failure_message = str(task.get("failMsg") or "") or None
            if actual_credits == 0 or balance_delta == 0:
                actual_cost_usd = 0.0

        completed_at = _utc_now()
        result = VideoGenerationResult(
            provider="kie.ai",
            model=str(task.get("model") or MODEL),
            task_id=task_id,
            status=state,
            estimated_cost_usd=estimated_cost,
            actual_cost_usd=actual_cost_usd,
            actual_credits=actual_credits,
            output_path=str(output_path) if output_path else None,
            created_at=created_at,
            completed_at=completed_at,
            failure_code=failure_code,
            failure_message=failure_message,
        )
        final_record = {
            **submitted_record,
            **asdict(result),
            "event": "completed",
            "credit_balance_after": balance_after,
            "credit_balance_delta": balance_delta,
            "actual_cost_basis": "published USD rate x duration" if actual_cost_usd is not None else None,
        }
        self._record(final_record)
        return result

    def generate_image_to_video(
        self,
        *,
        prompt: str,
        image_path: str | Path,
        duration: int,
        aspect_ratio: str,
        quality: str,
        budget: str | float | int,
        consistency_priority: str = "high",
    ) -> VideoGenerationResult:
        prompt = prompt.strip()
        if not prompt:
            raise ValueError("prompt must not be empty")
        if aspect_ratio not in VALID_ASPECT_RATIOS:
            raise ValueError(f"unsupported aspect_ratio: {aspect_ratio}")
        consistency = consistency_priority.strip().lower()
        if consistency not in VALID_CONSISTENCY:
            raise ValueError("consistency_priority must be low, medium, or high")
        quality_key = quality.strip().lower()
        if quality_key not in QUALITY_CONFIG:
            raise ValueError("quality must be low, standard, high, 480p, or 720p")
        resolution, _ = QUALITY_CONFIG[quality_key]
        estimated_cost = self.estimate_cost(duration, quality_key)
        limit = _budget_limit(budget)
        if estimated_cost > limit:
            raise KieVideoError(
                f"Cost guard blocked task: estimated ${estimated_cost:.4f} exceeds ${limit:.4f} budget"
            )

        source = Path(image_path)
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        image_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        created_at = _utc_now()
        balance_before = self.get_credit_balance()
        image_url = self.upload_reference_image(source)
        task_id = self.create_task(
            prompt=prompt,
            duration=duration,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            model=IMAGE_TO_VIDEO_MODEL,
            image_urls=[image_url],
        )
        submitted_record = {
            "event": "submitted",
            "provider": "kie.ai",
            "model": IMAGE_TO_VIDEO_MODEL,
            "task_id": task_id,
            "status": "submitted",
            "created_at": created_at,
            "prompt_sha256": prompt_hash,
            "reference_image_sha256": image_hash,
            "reference_image_path": str(source),
            "duration_seconds": duration,
            "aspect_ratio": aspect_ratio,
            "quality": quality_key,
            "resolution": resolution,
            "budget_limit_usd": limit,
            "consistency_priority": consistency,
            "estimated_cost_usd": estimated_cost,
            "credit_balance_before": balance_before,
            "actual_cost_usd": None,
            "actual_credits": None,
            "output_path": None,
        }
        self._record(submitted_record)

        task = self.wait_for_task(task_id)
        state = str(task.get("state", "unknown")).lower()
        balance_after = self.get_credit_balance()
        balance_delta = None
        if balance_before is not None and balance_after is not None:
            balance_delta = round(balance_before - balance_after, 6)
        consumed_value = task.get("creditsConsumed")
        try:
            actual_credits = float(consumed_value) if consumed_value is not None else balance_delta
        except (TypeError, ValueError):
            actual_credits = balance_delta

        output_path: Path | None = None
        failure_code = None
        failure_message = None
        actual_cost_usd: float | None = None
        if state == "success":
            result_json = _parse_embedded_json(task.get("resultJson"))
            urls = result_json.get("resultUrls") or []
            if not isinstance(urls, list) or not urls:
                raise KieVideoError(f"KIE task {task_id} succeeded but returned no video URL")
            output_path = self._download(str(urls[0]), task_id)
            actual_cost_usd = estimated_cost
        else:
            failure_code = str(task.get("failCode") or "") or None
            failure_message = str(task.get("failMsg") or "") or None
            if actual_credits == 0 or balance_delta == 0:
                actual_cost_usd = 0.0

        completed_at = _utc_now()
        result = VideoGenerationResult(
            provider="kie.ai",
            model=str(task.get("model") or IMAGE_TO_VIDEO_MODEL),
            task_id=task_id,
            status=state,
            estimated_cost_usd=estimated_cost,
            actual_cost_usd=actual_cost_usd,
            actual_credits=actual_credits,
            output_path=str(output_path) if output_path else None,
            created_at=created_at,
            completed_at=completed_at,
            failure_code=failure_code,
            failure_message=failure_message,
        )
        self._record(
            {
                **submitted_record,
                **asdict(result),
                "event": "completed",
                "credit_balance_after": balance_after,
                "credit_balance_delta": balance_delta,
                "actual_cost_basis": "configured USD rate x duration"
                if actual_cost_usd is not None
                else None,
            }
        )
        return result


def generate_video(
    prompt: str,
    duration: int,
    aspect_ratio: str,
    quality: str,
    budget: str | float | int,
    consistency_priority: str,
) -> VideoGenerationResult:
    """Generate one video through the currently configured provider."""
    return KieVideoAdapter.from_project_env().generate_video(
        prompt=prompt,
        duration=duration,
        aspect_ratio=aspect_ratio,
        quality=quality,
        budget=budget,
        consistency_priority=consistency_priority,
    )


def _main() -> int:
    parser = argparse.ArgumentParser(description="Kufucat low-cost KIE video smoke test")
    parser.add_argument(
        "--prompt",
        default=(
            "A sleepy orange cat stretches once on a plain warm gray background, "
            "static camera, soft daylight, no text, no logos."
        ),
    )
    parser.add_argument("--duration", type=int, default=6)
    parser.add_argument("--aspect-ratio", default="9:16")
    parser.add_argument("--quality", default="low")
    parser.add_argument("--budget", default="low")
    parser.add_argument("--consistency-priority", default="low")
    parser.add_argument(
        "--submit",
        action="store_true",
        help="Actually submit a paid generation. Without this flag, only estimate cost.",
    )
    args = parser.parse_args()
    if not args.submit:
        estimated = KieVideoAdapter("estimate-only").estimate_cost(args.duration, args.quality)
        print(json.dumps({"model": MODEL, "estimated_cost_usd": estimated, "submitted": False}))
        return 0
    result = generate_video(
        prompt=args.prompt,
        duration=args.duration,
        aspect_ratio=args.aspect_ratio,
        quality=args.quality,
        budget=args.budget,
        consistency_priority=args.consistency_priority,
    )
    print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    return 0 if result.status == "success" else 1


if __name__ == "__main__":
    raise SystemExit(_main())
