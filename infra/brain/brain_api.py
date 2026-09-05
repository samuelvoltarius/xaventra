#!/usr/bin/env python3
"""
Nova Brain API
==============
Graphiti episodic memory REST API for Nova.
Stores and retrieves knowledge as a graph in Neo4j via Graphiti.

Endpoints:
  POST /search          — semantic search over stored episodes
  POST /add_episode     — store a new episode (conversation, fact, decision)
  GET  /health          — liveness check
  GET  /stats           — node/edge counts

Deployed by Nova's Brain Installer (src/installer/brain-installer.ts).
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from typing import Optional

try:
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel
    import uvicorn
except ImportError:
    print("ERROR: fastapi/uvicorn missing. Run: pip install fastapi uvicorn")
    sys.exit(1)

try:
    from graphiti_core import Graphiti
    from graphiti_core.nodes import EpisodeType
except ImportError:
    print("ERROR: graphiti-core missing. Run: pip install graphiti-core")
    sys.exit(1)

# ── Config (env vars) ─────────────────────────────────────────────────────────

NEO4J_URI      = os.getenv("NEO4J_URI",      "bolt://localhost:7687")
NEO4J_USER     = os.getenv("NEO4J_USER",     "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "nova-brain-2026")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")   # for embeddings (optional if using local)
OLLAMA_URL     = os.getenv("OLLAMA_URL",     "http://localhost:11434")
PORT           = int(os.getenv("BRAIN_PORT", "8765"))
HOST           = os.getenv("BRAIN_HOST",     "0.0.0.0")

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Nova Brain API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

graphiti: Optional[Graphiti] = None


@app.on_event("startup")
async def startup():
    global graphiti
    print(f"[Brain] Connecting to Neo4j: {NEO4J_URI}")
    try:
        graphiti = Graphiti(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        await graphiti.build_indices_and_constraints()
        print("[Brain] ✅ Graphiti connected and indices ready")
    except Exception as e:
        print(f"[Brain] ❌ Neo4j connection failed: {e}")
        print("[Brain]    Is Neo4j running? Try: docker start nova-neo4j")
        graphiti = None


@app.on_event("shutdown")
async def shutdown():
    if graphiti:
        await graphiti.close()

# ── Models ────────────────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    limit: int = 5
    types: list[str] = ["fact", "decision", "preference"]  # filter by episode type
    group_id: str = "nova"


class SearchResult(BaseModel):
    content: str
    score: float
    type: str
    created_at: str
    episode_id: str


class AddEpisodeRequest(BaseModel):
    content: str
    type: str = "fact"          # fact | decision | preference | conversation
    source: str = "nova"        # who/what created this
    group_id: str = "nova"
    reference_time: Optional[str] = None   # ISO timestamp, defaults to now


class AddEpisodeResponse(BaseModel):
    ok: bool
    episode_id: str
    message: str


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "ok": graphiti is not None,
        "neo4j": NEO4J_URI,
        "version": "1.0.0",
    }


@app.get("/stats")
async def stats():
    if not graphiti:
        raise HTTPException(503, "Brain not connected")
    try:
        # Query Neo4j directly for counts
        async with graphiti.driver.session() as session:
            node_count = await session.run("MATCH (n) RETURN count(n) as c")
            n = await node_count.single()
            edge_count = await session.run("MATCH ()-[r]->() RETURN count(r) as c")
            e = await edge_count.single()
        return {"nodes": n["c"], "edges": e["c"]}
    except Exception as ex:
        raise HTTPException(500, str(ex))


@app.post("/search", response_model=list[SearchResult])
async def search(req: SearchRequest):
    if not graphiti:
        raise HTTPException(503, "Brain not connected — Neo4j unreachable")
    try:
        results = await graphiti.search(
            query=req.query,
            group_ids=[req.group_id],
            num_results=req.limit,
        )
        out = []
        for r in results:
            # Graphiti returns EpisodeNode or EntityEdge objects
            content = getattr(r, "content", None) or getattr(r, "fact", None) or str(r)
            score   = getattr(r, "score", None) or getattr(r, "relevance_score", 0.0)
            ep_type = getattr(r, "source_description", "fact")
            created = getattr(r, "created_at", datetime.now(timezone.utc))
            ep_id   = getattr(r, "uuid", "") or getattr(r, "name", "")
            out.append(SearchResult(
                content=str(content),
                score=float(score) if score is not None else 0.0,
                type=str(ep_type),
                created_at=created.isoformat() if hasattr(created, "isoformat") else str(created),
                episode_id=str(ep_id),
            ))
        return out
    except Exception as ex:
        raise HTTPException(500, f"Search failed: {ex}")


@app.post("/add_episode", response_model=AddEpisodeResponse)
async def add_episode(req: AddEpisodeRequest):
    if not graphiti:
        raise HTTPException(503, "Brain not connected")
    try:
        ref_time = (
            datetime.fromisoformat(req.reference_time)
            if req.reference_time
            else datetime.now(timezone.utc)
        )
        episode = await graphiti.add_episode(
            name=f"{req.source}:{req.type}:{ref_time.timestamp():.0f}",
            episode_body=req.content,
            source=EpisodeType.text,
            source_description=req.type,
            group_id=req.group_id,
            reference_time=ref_time,
        )
        ep_id = getattr(episode, "uuid", "") or getattr(episode, "name", "added")
        return AddEpisodeResponse(ok=True, episode_id=str(ep_id), message="Stored")
    except Exception as ex:
        raise HTTPException(500, f"add_episode failed: {ex}")


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"""
╔══════════════════════════════════════════╗
║         Nova Brain API v1.0              ║
╠══════════════════════════════════════════╣
║  Neo4j:  {NEO4J_URI:<31} ║
║  Port:   {PORT:<31} ║
╚══════════════════════════════════════════╝
""")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
