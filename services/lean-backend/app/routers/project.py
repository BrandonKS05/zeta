from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from ..database import (
    DEMO_PROJECT_ID,
    Document,
    NotationNode,
    get_db,
)
from ..notation_graph import extract_notations_from_latex, find_cross_file_conflicts

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/project", tags=["project"])


class SyncFilePayload(BaseModel):
    file_path: str = Field(min_length=1)
    content: str


class SyncBatchPayload(BaseModel):
    files: list[SyncFilePayload]


class NotationNodeOut(BaseModel):
    id: str
    symbol: str
    latex_type: str
    lean_type: str
    defined_in: str
    context_text: str


class ConflictOut(BaseModel):
    symbol: str
    definitions: list[dict[str, Any]]
    message: str


class ProjectStatusOut(BaseModel):
    project_id: str
    document_count: int
    notation_count: int
    conflicts: list[ConflictOut]


class NotationGraphOut(BaseModel):
    project_id: str
    notations: list[NotationNodeOut]
    conflicts: list[ConflictOut]


@router.get("/status", response_model=ProjectStatusOut)
async def project_status():
    db = get_db()
    try:
        doc_count = db.query(Document).filter(Document.project_id == DEMO_PROJECT_ID).count()
        notation_count = db.query(NotationNode).filter(NotationNode.project_id == DEMO_PROJECT_ID).count()
        notations = db.query(NotationNode).filter(NotationNode.project_id == DEMO_PROJECT_ID).all()
        conflicts = find_cross_file_conflicts(notations)
        return ProjectStatusOut(
            project_id=DEMO_PROJECT_ID,
            document_count=doc_count,
            notation_count=notation_count,
            conflicts=[
                ConflictOut(
                    symbol=c["symbol"],
                    definitions=c["definitions"],
                    message=c["message"],
                )
                for c in conflicts
            ],
        )
    finally:
        db.close()


@router.get("/notations", response_model=NotationGraphOut)
async def get_notation_graph():
    db = get_db()
    try:
        notations = db.query(NotationNode).filter(NotationNode.project_id == DEMO_PROJECT_ID).all()
        conflicts = find_cross_file_conflicts(notations)
        return NotationGraphOut(
            project_id=DEMO_PROJECT_ID,
            notations=[
                NotationNodeOut(
                    id=n.id,
                    symbol=n.symbol,
                    latex_type=n.latex_type,
                    lean_type=n.lean_type,
                    defined_in=n.defined_in,
                    context_text=n.context_text,
                )
                for n in notations
            ],
            conflicts=[
                ConflictOut(
                    symbol=c["symbol"],
                    definitions=c["definitions"],
                    message=c["message"],
                )
                for c in conflicts
            ],
        )
    finally:
        db.close()


@router.post("/sync")
async def sync_files(payload: SyncBatchPayload):
    started = time.perf_counter()
    db = get_db()
    try:
        upserted = 0
        for f in payload.files:
            existing = (
                db.query(Document)
                .filter(Document.project_id == DEMO_PROJECT_ID, Document.file_path == f.file_path)
                .first()
            )
            if existing:
                existing.content = f.content
            else:
                db.add(Document(
                    project_id=DEMO_PROJECT_ID,
                    file_path=f.file_path,
                    content=f.content,
                ))
            upserted += 1
        db.commit()

        all_docs = db.query(Document).filter(Document.project_id == DEMO_PROJECT_ID).all()
        all_notations: list[dict[str, Any]] = []
        for doc in all_docs:
            extracted = await extract_notations_from_latex(doc.file_path, doc.content)
            all_notations.extend(extracted)

        db.query(NotationNode).filter(NotationNode.project_id == DEMO_PROJECT_ID).delete()
        seen_keys: set[str] = set()
        for n in all_notations:
            key = f"{n['symbol']}::{n['defined_in']}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            node = NotationNode(
                project_id=DEMO_PROJECT_ID,
                symbol=n["symbol"],
                latex_type=n.get("latex_type", "unknown"),
                lean_type=n.get("lean_type", "unknown"),
                defined_in=n["defined_in"],
                context_text=n.get("context_text", ""),
            )
            db.add(node)
        db.commit()

        notations = db.query(NotationNode).filter(NotationNode.project_id == DEMO_PROJECT_ID).all()
        conflicts = find_cross_file_conflicts(notations)
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.info(
            "project_sync complete docs=%d notations=%d conflicts=%d duration_ms=%.2f",
            upserted,
            len(notations),
            len(conflicts),
            elapsed_ms,
        )
        return {
            "ok": True,
            "project_id": DEMO_PROJECT_ID,
            "documents_synced": upserted,
            "notations_extracted": len(notations),
            "conflicts": [
                {
                    "symbol": c["symbol"],
                    "definitions": c["definitions"],
                    "message": c["message"],
                }
                for c in conflicts
            ],
            "duration_ms": round(elapsed_ms, 2),
        }
    finally:
        db.close()


@router.websocket("/ws")
async def project_websocket(websocket: WebSocket):
    await websocket.accept()
    logger.info("project_ws client connected")
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"error": "invalid JSON"})
                continue

            msg_type = message.get("type", "")

            if msg_type == "sync":
                files = message.get("files", [])
                await websocket.send_json({"type": "ack", "status": "processing", "file_count": len(files)})

                db = get_db()
                try:
                    for f in files:
                        fp = f.get("filePath", f.get("file_path", ""))
                        content = f.get("content", "")
                        if not fp:
                            continue
                        existing = (
                            db.query(Document)
                            .filter(Document.project_id == DEMO_PROJECT_ID, Document.file_path == fp)
                            .first()
                        )
                        if existing:
                            existing.content = content
                        else:
                            db.add(Document(
                                project_id=DEMO_PROJECT_ID,
                                file_path=fp,
                                content=content,
                            ))
                    db.commit()

                    all_docs = db.query(Document).filter(Document.project_id == DEMO_PROJECT_ID).all()
                    all_notations: list[dict[str, Any]] = []
                    for doc in all_docs:
                        extracted = await extract_notations_from_latex(doc.file_path, doc.content)
                        all_notations.extend(extracted)

                    db.query(NotationNode).filter(NotationNode.project_id == DEMO_PROJECT_ID).delete()
                    ws_seen_keys: set[str] = set()
                    for n in all_notations:
                        key = f"{n['symbol']}::{n['defined_in']}"
                        if key in ws_seen_keys:
                            continue
                        ws_seen_keys.add(key)
                        node = NotationNode(
                            project_id=DEMO_PROJECT_ID,
                            symbol=n["symbol"],
                            latex_type=n.get("latex_type", "unknown"),
                            lean_type=n.get("lean_type", "unknown"),
                            defined_in=n["defined_in"],
                            context_text=n.get("context_text", ""),
                        )
                        db.add(node)
                    db.commit()

                    notations = db.query(NotationNode).filter(
                        NotationNode.project_id == DEMO_PROJECT_ID
                    ).all()
                    conflicts = find_cross_file_conflicts(notations)

                    await websocket.send_json({
                        "type": "sync_result",
                        "project_id": DEMO_PROJECT_ID,
                        "notations": [
                            {
                                "symbol": n.symbol,
                                "latex_type": n.latex_type,
                                "lean_type": n.lean_type,
                                "defined_in": n.defined_in,
                                "context_text": n.context_text,
                            }
                            for n in notations
                        ],
                        "conflicts": [
                            {
                                "symbol": c["symbol"],
                                "definitions": c["definitions"],
                                "message": c["message"],
                            }
                            for c in conflicts
                        ],
                    })
                finally:
                    db.close()

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

            else:
                await websocket.send_json({"error": f"unknown message type: {msg_type}"})

    except WebSocketDisconnect:
        logger.info("project_ws client disconnected")
    except Exception:
        logger.exception("project_ws error")
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
