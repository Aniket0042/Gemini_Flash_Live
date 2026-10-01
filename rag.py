"""
RAG Engine for Gemini Flash Live.
Performs ultra-fast semantic retrieval using faiss.index (384-dimensional BAAI/bge-small-en-v1.5)
and maps vector hits to authoritative UAE Tax / VAT legislation, Cabinet Decisions, and Guides.
"""

import os
import time
import json
import logging
from typing import List, Dict, Any, Tuple, Optional
import numpy as np
import faiss
from fastembed import TextEmbedding
import re

logger = logging.getLogger("rag")
logging.basicConfig(level=logging.INFO)

def clean_str(s: str) -> str:
    if not s:
        return ""
    s = s.replace('\u2013', '-').replace('\u2014', '-').replace('\u2018', "'").replace('\u2019', "'").replace('\u201c', '"').replace('\u201d', '"').replace('\ufffd', ' ')
    return re.sub(r'[^\x20-\x7E]+', ' ', s).strip()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_PATH = os.path.join(BASE_DIR, "faiss.index")
MAPPING_PATH = os.path.join(BASE_DIR, "vector_to_doc.json")
MANIFEST_PATH = os.path.join(BASE_DIR, "manifest.csv")

class RAGEngine:
    def __init__(self, index_path: str = INDEX_PATH, mapping_path: str = MAPPING_PATH):
        self.index_path = index_path
        self.mapping_path = mapping_path
        self.index = None
        self.mapping = {}
        self.embedder = None
        self.is_ready = False
        self._initialize()

    def _initialize(self):
        try:
            if not os.path.exists(self.index_path):
                logger.warning(f"FAISS index not found at {self.index_path}")
                return

            t0 = time.time()
            self.index = faiss.read_index(self.index_path)

            if os.path.exists(self.mapping_path):
                with open(self.mapping_path, "r", encoding="utf-8") as f:
                    self.mapping = json.load(f)

            # Initialize BGE-small embedding model
            self.embedder = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
            self.is_ready = True
            logger.info(f"RAG Engine loaded in {time.time() - t0:.2f}s with {self.index.ntotal} vectors and {len(self.mapping)} document mappings.")
        except Exception as e:
            logger.error(f"Failed to initialize RAGEngine: {e}", exc_info=True)
            self.is_ready = False

    def search(self, query: str, top_k: int = 3) -> Tuple[List[Dict[str, Any]], float]:
        """
        Embeds query with 'query: ' prefix and searches faiss.index.
        Returns deduplicated top matching documents and retrieval latency in ms.
        """
        if not self.is_ready or not query or not query.strip():
            return [], 0.0

        t0 = time.time()
        query_text = "query: " + query.strip()
        q_emb = list(self.embedder.embed([query_text]))[0]
        q_vec = np.array(q_emb, dtype=np.float32).reshape(1, -1)
        faiss.normalize_L2(q_vec)

        # Retrieve top candidates to allow deduplication across multiple chunks of same doc
        candidates = min(top_k * 5, self.index.ntotal)
        D, I = self.index.search(q_vec, candidates)

        results = []
        seen_titles = set()

        for score, vec_id in zip(D[0], I[0]):
            meta = self.mapping.get(str(vec_id))
            if not meta:
                continue

            title = meta.get("title", "")
            if not title or title in seen_titles:
                continue

            seen_titles.add(title)
            results.append({
                "vector_id": int(vec_id),
                "title": title,
                "category": meta.get("category", ""),
                "section": meta.get("section", ""),
                "issue_date": meta.get("issue_date", ""),
                "url": meta.get("url", ""),
                "file": meta.get("file", ""),
                "similarity": round(float(score), 3)
            })

            if len(results) >= top_k:
                break

        latency_ms = round((time.time() - t0) * 1000, 1)
        return results, latency_ms

    def build_rag_context(self, query: str, top_k: int = 3) -> Tuple[str, List[Dict[str, Any]], float]:
        """
        Retrieves context documents and builds an injected prompt section.
        """
        docs, latency_ms = self.search(query, top_k=top_k)
        if not docs:
            return "", [], latency_ms

        lines = [
            "[AUTHORITATIVE UAE TAX & VAT KNOWLEDGE BASE]",
            "The following official UAE Federal Tax Authority (FTA) legislation, Cabinet Decisions, and Guides are directly relevant to this query:",
            ""
        ]

        for i, d in enumerate(docs, 1):
            date_info = f" (Issued: {d['issue_date']})" if d['issue_date'] and d['issue_date'] != 'NA' else ""
            clean_title = clean_str(d['title'])
            clean_cat = clean_str(d['category'])
            clean_sec = clean_str(d['section'])
            lines.append(f"{i}. Title: {clean_title}{date_info}")
            lines.append(f"   Category: {clean_cat} | Section: {clean_sec}")
            if d['url']:
                lines.append(f"   Official URL: {d['url']}")
            lines.append("")

        lines.append(
            "Instructions: Ground your response in the specific legislation and directives referenced above. "
            "Cite the official FTA decisions, Cabinet decisions, or guide titles accurately to provide verified tax advice."
        )

        return "\n".join(lines), docs, latency_ms

_global_rag = None

def get_rag_engine() -> RAGEngine:
    global _global_rag
    if _global_rag is None:
        _global_rag = RAGEngine()
    return _global_rag
