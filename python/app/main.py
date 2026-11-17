"""PaperDesk 本地 sidecar（FastAPI）。

职责：把重活（PDF 解析、GROBID、Crossref）放到独立进程，主进程用 HTTP 调用。
启动：python -m uvicorn app.main:app --host 127.0.0.1 --port <port>
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import crossref, grobid
from .embed import embed_texts
from .extract import extract_local, normalize_doi
from .translate import simple_translate


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _start_parent_watchdog() -> None:
    """父进程（Electron 主进程）退出后，sidecar 自动结束，避免残留进程。"""
    raw = os.environ.get("PAPERDESK_PARENT_PID")
    if not raw:
        return
    try:
        ppid = int(raw)
    except ValueError:
        return

    def run() -> None:
        while True:
            time.sleep(5)
            if not _pid_alive(ppid):
                os._exit(0)

    threading.Thread(target=run, daemon=True).start()


_start_parent_watchdog()

app = FastAPI(title="paperdesk-sidecar", version="0.1.0")


class ExtractRequest(BaseModel):
    path: str
    grobidUrl: str | None = None
    resolveCrossref: bool = False
    crossrefLimit: int = 12
    mailto: str | None = None


class GrobidHealthRequest(BaseModel):
    url: str


class TranslateRequest(BaseModel):
    path: str
    outPath: str
    targetLang: str = "zh"
    engine: str = "simple"  # simple | vision | pdf2zh
    backend: str = "mock"  # mock | none | openai
    baseUrl: str | None = None
    apiKey: str | None = None
    model: str | None = None
    headers: dict[str, str] | None = None
    htmlPath: str | None = None
    bilingualPath: str | None = None
    mdPath: str | None = None
    bilingualMdPath: str | None = None
    skillsDir: str | None = None
    docTitle: str | None = None
    docAuthors: str | None = None
    maxWorkers: int = 4
    # 模块化过滤：页(0 基) -> 不翻译区域 [[x0,y0,x1,y1], ...]（**底边原点**，与模块层一致）
    skipRects: dict[str, list[list[float]]] | None = None
    # 每批块数（OpenCode Go 等共享网关建议较小，避免网关侧排队）
    batchSize: int | None = None
    mode: str = "fine"
    layout: str = "reflow"
    # 术语表：每行 `英文=中文`（用户自定义，优先于自动抽取）
    glossary: str | None = None
    # 是否自动从摘要/正文抽取术语表（会多一次短请求，可关闭）
    autoGlossary: bool = True
    # 翻译时关闭模型「思考」（默认开：论文段落翻译不需要推理，开着会白等几十秒）
    noThink: bool = True
    # 译文正文字号增量（pt）：0 = 与原文同字号；默认 +1.5（用户可调，整篇/单页/批处理一致）
    fontDelta: float = 1.5


class SkillSaveRequest(BaseModel):
    dir: str
    id: str
    system: str | None = None
    skip: bool | None = None
    scope: str | None = None


class SkillsDirRequest(BaseModel):
    dir: str


class ZipRequest(BaseModel):
    outPath: str
    files: list[str]


class SkillsImportRequest(BaseModel):
    dir: str
    skills: list[dict]
    force: bool = False
    only: list[str] | None = None


class EmbedRequest(BaseModel):
    texts: list[str]
    backend: str = "mock"  # mock | openai | none
    baseUrl: str | None = None
    apiKey: str | None = None
    model: str | None = None
    headers: dict[str, str] | None = None


class TranslateTextRequest(BaseModel):
    texts: list[str]
    targetLang: str = "zh"
    backend: str = "mock"  # mock | none | openai
    baseUrl: str | None = None
    apiKey: str | None = None
    model: str | None = None
    headers: dict[str, str] | None = None
    # 划词翻译同样默认关闭思考（服务端不支持时侧车自动降级）
    noThink: bool = True


class TranslatePageRequest(TranslateRequest):
    """只重译既有译文 PDF 的某一页（1 基）。"""

    page: int


class ExportRequest(BaseModel):
    path: str
    outPath: str
    format: str = "md"  # md | html | pdf
    engine: str = "simple"  # 预留：simple | mineru


class StructureRequest(BaseModel):
    path: str


class VisionMetadataRequest(BaseModel):
    path: str
    baseUrl: str | None = None
    apiKey: str | None = None
    model: str | None = None
    headers: dict[str, str] | None = None
    maxPages: int = 2


class InspectRequest(BaseModel):
    path: str


@app.post("/translate/text")
def translate_texts(req: TranslateTextRequest) -> dict:
    from .translate import translate_text

    out: list[str] = []
    error: str | None = None
    for t in req.texts:
        try:
            out.append(
                translate_text(
                    t,
                    req.backend,
                    req.targetLang,
                    req.baseUrl,
                    req.apiKey,
                    req.model,
                    req.headers,
                    no_think=req.noThink,
                    font_delta=float(req.fontDelta),
                )
            )
        except Exception as exc:  # noqa: BLE001
            error = str(exc)[:200]
            out.append(t)
    return {"backend": req.backend, "texts": out, "error": error}


@app.post("/export")
def export_doc(req: ExportRequest) -> dict:
    try:
        from .export import export_document

        return export_document(req.path, req.outPath, req.format, req.engine)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"导出失败: {exc}") from exc


@app.post("/embed")
def embed(req: EmbedRequest) -> dict:
    try:
        return embed_texts(
            req.texts, req.backend, req.baseUrl, req.apiKey, req.model, req.headers
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"向量化失败: {exc}") from exc


@app.post("/structure")
def structure(req: StructureRequest) -> dict:
    try:
        from .structure import extract_structure

        return extract_structure(req.path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"结构提取失败: {exc}") from exc


@app.post("/modules")
def modules(req: InspectRequest) -> dict:
    """结构化模块层：章节/段落/图片/表格/图注/表注/公式/定理/参考文献 + 关联关系。

    纯脚本（PyMuPDF）：处理跨行断裂、双栏排版、编号与内容分离；正则与坐标作为辅助与回退。
    坐标统一为**底边原点**（y 向上，与 pdf.js 一致）。
    """
    try:
        from .modules import extract_modules

        return extract_modules(req.path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"模块解析失败: {exc}") from exc


@app.post("/figures")
def figures(req: InspectRequest) -> dict:
    """返回每页的「矢量图形区域」包围盒与图表题注（用于点击图表引用时精确裁剪预览）。

    坐标统一为**底边原点**（y 向上，与 pdf.js 一致）：便于渲染层直接使用。
    """
    try:
        import re

        import fitz

        from .translate import _figure_regions

        doc = fitz.open(req.path)
        pages: list[dict] = []
        try:
            for pno, page in enumerate(doc):
                h = float(page.rect.height)
                regs = _figure_regions(page)
                caps: list[dict] = []
                data = page.get_text("dict")
                for b in data.get("blocks", []):
                    if b.get("type") != 0:
                        continue
                    raw = " ".join(
                        "".join(s.get("text", "") for s in ln.get("spans", []))
                        for ln in b.get("lines", [])
                    ).strip()
                    if not raw:
                        continue
                    m = re.match(r"^(fig(?:ure)?|tab(?:le)?|图|表)\.?\s*0*(\d+)([a-z])?", raw, re.I)
                    if not m:
                        continue
                    bb = b.get("bbox") or (0, 0, 0, 0)
                    kw = m.group(1).lower()
                    caps.append(
                        {
                            "n": int(m.group(2)),
                            "letter": (m.group(3) or "").lower(),
                            "kind": "table" if kw.startswith("tab") or kw == "表" else "figure",
                            # 底边原点：y0 = h - y1_top，y1 = h - y0_top
                            "rect": [bb[0], h - bb[3], bb[2], h - bb[1]],
                        }
                    )
                if regs or caps:
                    pages.append(
                        {
                            "page": pno + 1,
                            "w": float(page.rect.width),
                            "h": float(page.rect.height),
                            "rects": [[r.x0, h - r.y1, r.x1, h - r.y0] for r in regs],
                            "captions": caps,
                        }
                    )
        finally:
            doc.close()
        return {"pages": pages}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"图形区域提取失败: {exc}") from exc


class FigureImageRequest(BaseModel):
    path: str
    page: int
    rect: list[float]  # 底边原点 [x0, y0, x1, y1]
    scale: float = 1.0


class FormulaImageRequest(BaseModel):
    imageB64: str
    mime: str = "image/png"
    baseUrl: str | None = None
    apiKey: str | None = None
    model: str | None = None
    headers: dict | None = None


_FORMULA_PROMPT = (
    "你是数学公式识别助手。先判断图片里**是否包含数学公式 / 定理**：\n"
    "- 如果**不包含**（例如纯文字段落、表格、折线图/柱状图、照片、流程图、只有数字），"
    '必须返回 {"latex": "", "kind": "none", "note": "该图片不包含公式"}；\n'
    "- 如果包含，输出**严格 JSON**（不要多余文字、不要 Markdown 代码围栏）：\n"
    '{"latex": 字符串, "kind": "inline"|"display"|"theorem", "note": 字符串或 null}\n'
    "latex 用标准 LaTeX（**不要**用 $ 包裹，多行公式用 \\\\ 换行）；"
    "note 可写简短说明（如公式编号/所属定理）或 null。只输出 JSON。"
)


@app.post("/vision/formula")
def vision_formula(req: FormulaImageRequest) -> dict:
    """把图片里的公式识别成 LaTeX（用视觉模型；不落盘）。"""
    try:
        from .vision import chat_vision

        text = chat_vision(
            req.baseUrl,
            req.apiKey,
            req.model,
            req.headers,
            _FORMULA_PROMPT,
            [req.imageB64],
            timeout=120.0,
        )
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
        try:
            data = json.loads(text)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"模型未返回合法 JSON：{str(exc)[:120]}") from exc
        return {
            "latex": str(data.get("latex") or "").strip(),
            "kind": str(data.get("kind") or "none"),
            "note": data.get("note"),
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"公式识别失败: {exc}") from exc


@app.post("/figure-image")
def figure_image(req: FigureImageRequest) -> dict:
    """把某页的某个区域渲染成 PNG（base64），用于网页译文里点击图表引用后的预览。"""
    try:
        import base64

        import fitz

        doc = fitz.open(req.path)
        try:
            page = doc[req.page - 1]
            h = float(page.rect.height)
            x0, y0, x1, y1 = req.rect
            # 转回 PyMuPDF 坐标（顶边原点）
            clip = fitz.Rect(min(x0, x1), h - max(y0, y1), max(x0, x1), h - min(y0, y1))
            sc = max(0.3, min(3.0, float(req.scale) or 1.0))
            pix = page.get_pixmap(clip=clip, matrix=fitz.Matrix(sc, sc), alpha=False)
            return {
                "png": base64.b64encode(pix.tobytes("png")).decode("ascii"),
                "w": pix.width,
                "h": pix.height,
            }
        finally:
            doc.close()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"图表渲染失败: {exc}") from exc


@app.post("/skills/list")
def skills_list(req: SkillsDirRequest) -> dict:
    try:
        from .skills import list_skills

        return {"skills": list_skills(req.dir)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"读取翻译技能失败: {exc}") from exc


@app.post("/skills/save")
def skills_save(req: SkillSaveRequest) -> dict:
    try:
        from .skills import save_skill

        return {"skill": save_skill(req.dir, req.id, req.system, req.skip, req.scope)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"保存翻译技能失败: {exc}") from exc


@app.post("/skills/reset")
def skills_reset(req: SkillsDirRequest) -> dict:
    try:
        from .skills import list_skills, reset_skills

        reset_skills(req.dir)
        return {"skills": list_skills(req.dir)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"恢复默认技能失败: {exc}") from exc


@app.post("/skills/import")
def skills_import(req: SkillsImportRequest) -> dict:
    try:
        from .skills import import_skills, list_skills

        r = import_skills(req.dir, req.skills, req.force, req.only)
        return {
            "imported": r["imported"],
            "conflicts": r["conflicts"],
            "updates": r.get("updates", []),
            "skills": list_skills(req.dir),
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"导入技能失败: {exc}") from exc


@app.post("/zip")
def make_zip(req: ZipRequest) -> dict:
    """把若干产物文件打包成一个 zip（用于一键导出）。"""
    import os
    import zipfile

    try:
        n = 0
        os.makedirs(os.path.dirname(req.outPath) or ".", exist_ok=True)
        with zipfile.ZipFile(req.outPath, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in req.files:
                if p and os.path.exists(p):
                    zf.write(p, os.path.basename(p))
                    n += 1
        return {"ok": True, "count": n, "outPath": req.outPath}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"打包失败: {exc}") from exc

@app.post("/vision/metadata")
def vision_metadata(req: VisionMetadataRequest) -> dict:
    try:
        from .vision import extract_metadata_vision

        return extract_metadata_vision(
            req.path, req.baseUrl, req.apiKey, req.model, req.headers, req.maxPages
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"视觉元数据抽取失败: {exc}") from exc


@app.post("/inspect")
def inspect(req: InspectRequest) -> dict:
    """快速体检：页数 / 文本层字符数 / 文本块数（判断是否扫描件、能否走内置引擎）。"""
    import fitz

    try:
        doc = fitz.open(req.path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"无法读取 PDF: {exc}") from exc
    try:
        pages = doc.page_count
        chars = 0
        blocks = 0
        for page in doc:
            text = page.get_text("text")
            chars += sum(1 for ch in text if not ch.isspace())
            blocks += sum(
                1 for b in page.get_text("blocks") if len(b) >= 5 and str(b[4]).strip()
            )
    finally:
        doc.close()
    return {
        "pageCount": pages,
        "textChars": chars,
        "textBlocks": blocks,
        "scanned": pages > 0 and chars < 50,
    }


@app.get("/health")
def health() -> dict:
    from .mineru_engine import is_available as mineru_available
    from .pdf2zh_engine import _find_cli as pdf2zh_cli

    try:
        mineru = mineru_available()
    except Exception:  # noqa: BLE001
        mineru = False
    try:
        pdf2zh = bool(pdf2zh_cli())
    except Exception:  # noqa: BLE001
        pdf2zh = False
    return {"status": "ok", "mineru": mineru, "pdf2zh": pdf2zh}


@app.post("/grobid/health")
def grobid_health(req: GrobidHealthRequest) -> dict:
    return {"available": grobid.is_available(req.url)}


@app.post("/extract")
def extract(req: ExtractRequest) -> dict:
    try:
        result = extract_local(req.path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"无法读取 PDF: {exc}") from exc

    # GROBID 可用时用更精确的标题/作者/引用覆盖
    if req.grobidUrl and grobid.is_available(req.grobidUrl):
        try:
            g = grobid.process_fulltext(req.path, req.grobidUrl)
            if g.get("metadata", {}).get("title"):
                result["metadata"]["title"] = g["metadata"]["title"]
            if g.get("metadata", {}).get("authors"):
                result["metadata"]["authors"] = g["metadata"]["authors"]
            if g.get("references"):
                result["references"] = g["references"]
            result["contexts"] = g.get("contexts", [])
            result["source"] = "grobid"
        except Exception as exc:  # noqa: BLE001
            result["warnings"].append(f"GROBID 处理失败: {exc}")
    elif req.grobidUrl:
        result["warnings"].append("GROBID 服务不可达，已使用本地降级解析")

    # 可选：对没有 DOI 的参考文献做 Crossref 模糊匹配（网络依赖，限量 + 超时 + 总预算；并发执行）
    if req.resolveCrossref:
        candidates = [r for r in result["references"] if not r.get("doi")][: max(0, req.crossrefLimit)]
        if candidates:
            deadline = time.monotonic() + 15.0
            resolved = 0
            error_reported = False

            def _lookup(ref: dict) -> dict | None:
                return crossref.lookup(ref.get("raw") or "", req.mailto, timeout=5.0)

            with ThreadPoolExecutor(max_workers=min(6, len(candidates))) as pool:
                future_map = {pool.submit(_lookup, r): r for r in candidates}
                for fut in as_completed(future_map):
                    if time.monotonic() > deadline:
                        break
                    ref = future_map[fut]
                    try:
                        hit = fut.result()
                    except Exception as exc:  # noqa: BLE001
                        if not error_reported:
                            result["warnings"].append(f"Crossref 查询失败: {str(exc)[:120]}")
                            error_reported = True
                        continue
                    if hit and hit.get("doi"):
                        ref["doi"] = normalize_doi(hit["doi"])
                        ref["title"] = hit.get("title") or ref.get("title")
                        ref["via"] = "crossref"
                        resolved += 1
            if resolved == 0 and not any("Crossref" in w for w in result["warnings"]):
                result["warnings"].append(f"已尝试 Crossref 消解 {len(candidates)} 条，未匹配到 DOI")

    result["resolvedCount"] = sum(1 for r in result["references"] if r.get("doi"))
    return result


@app.post("/translate")
def translate(req: TranslateRequest) -> dict:
    if req.engine == "vision":
        from .vision import translate_pdf_vision

        return translate_pdf_vision(
            req.path,
            req.outPath,
            req.targetLang,
            req.baseUrl,
            req.apiKey,
            req.model,
            req.headers,
            html_out=req.htmlPath,
            md_out=req.mdPath,
            max_workers=req.maxWorkers,
        )
    if req.engine == "pdf2zh":
        try:
            from .pdf2zh_engine import run_pdf2zh

            return run_pdf2zh(req.path, req.outPath, req.targetLang)
        except Exception as exc:  # noqa: BLE001
            result = simple_translate(
                req.path,
                req.outPath,
                req.targetLang,
                req.backend,
                req.baseUrl,
                req.apiKey,
                req.model,
                req.headers,
                html_out=req.htmlPath,
                bilingual_out=req.bilingualPath,
                md_out=req.mdPath,
                bilingual_md_out=req.bilingualMdPath,
                skills_dir=req.skillsDir,
                doc_title=req.docTitle,
                doc_authors=req.docAuthors,
                max_workers=req.maxWorkers,
                skip_rects=req.skipRects,
                batch_size=req.batchSize,
                mode=req.mode,
                layout=req.layout,
                glossary=req.glossary,
                auto_glossary=req.autoGlossary,
                no_think=req.noThink,
                font_delta=float(req.fontDelta),
            )
            result["warnings"] = list(result.get("warnings", [])) + [
                f"pdf2zh 不可用，已回退内置引擎: {str(exc)[:150]}"
            ]
            return result

    return simple_translate(
        req.path,
        req.outPath,
        req.targetLang,
        req.backend,
        req.baseUrl,
        req.apiKey,
        req.model,
        req.headers,
        html_out=req.htmlPath,
        bilingual_out=req.bilingualPath,
        max_workers=req.maxWorkers,
                skip_rects=req.skipRects,
                batch_size=req.batchSize,
                mode=req.mode,
                layout=req.layout,
                glossary=req.glossary,
                auto_glossary=req.autoGlossary,
                no_think=req.noThink,
                font_delta=float(req.fontDelta),
            )


# ============ 异步翻译任务（避免超长 HTTP 请求；可查进度、可取消） ============
_JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()


def _job_update(job_id: str, **kw) -> None:
    with _JOBS_LOCK:
        if job_id in _JOBS:
            _JOBS[job_id].update(kw)


def _prune_jobs() -> None:
    """只保留最近 20 个已结束的任务，避免内存增长。"""
    with _JOBS_LOCK:
        finished = [k for k, v in _JOBS.items() if v.get("status") in ("done", "error")]
        for k in finished[:-20]:
            _JOBS.pop(k, None)


def _run_translate_job(job_id: str, req: TranslateRequest) -> None:
    def on_progress(stage: str, done: int, total: int) -> None:
        _job_update(job_id, stage=stage, done=done, total=total)

    def is_cancelled() -> bool:
        with _JOBS_LOCK:
            return bool(_JOBS.get(job_id, {}).get("cancel"))

    try:
        if req.engine == "vision":
            from .vision import translate_pdf_vision

            result = translate_pdf_vision(
                req.path,
                req.outPath,
                req.targetLang,
                req.baseUrl,
                req.apiKey,
                req.model,
                req.headers,
                on_progress,
                is_cancelled,
                html_out=req.htmlPath,
                md_out=req.mdPath,
                max_workers=req.maxWorkers,
            )
        elif req.engine == "pdf2zh":
            try:
                from .pdf2zh_engine import run_pdf2zh

                result = run_pdf2zh(req.path, req.outPath, req.targetLang)
            except Exception as exc:  # noqa: BLE001
                result = simple_translate(
                    req.path,
                    req.outPath,
                    req.targetLang,
                    req.backend,
                    req.baseUrl,
                    req.apiKey,
                    req.model,
                    req.headers,
                    on_progress,
                    is_cancelled,
                    html_out=req.htmlPath,
                    bilingual_out=req.bilingualPath,
                md_out=req.mdPath,
                bilingual_md_out=req.bilingualMdPath,
                skills_dir=req.skillsDir,
                doc_title=req.docTitle,
                doc_authors=req.docAuthors,
                    max_workers=req.maxWorkers,
                skip_rects=req.skipRects,
                batch_size=req.batchSize,
                mode=req.mode,
                layout=req.layout,
                glossary=req.glossary,
                auto_glossary=req.autoGlossary,
                no_think=req.noThink,
                font_delta=float(req.fontDelta),
            )
                result["warnings"] = list(result.get("warnings", [])) + [
                    f"pdf2zh 不可用，已回退内置引擎: {str(exc)[:150]}"
                ]
        else:
            result = simple_translate(
                req.path,
                req.outPath,
                req.targetLang,
                req.backend,
                req.baseUrl,
                req.apiKey,
                req.model,
                req.headers,
                on_progress,
                is_cancelled,
                html_out=req.htmlPath,
                bilingual_out=req.bilingualPath,
                md_out=req.mdPath,
                bilingual_md_out=req.bilingualMdPath,
                skills_dir=req.skillsDir,
                doc_title=req.docTitle,
                doc_authors=req.docAuthors,
                max_workers=req.maxWorkers,
                skip_rects=req.skipRects,
                batch_size=req.batchSize,
                mode=req.mode,
                layout=req.layout,
                glossary=req.glossary,
                auto_glossary=req.autoGlossary,
                no_think=req.noThink,
                font_delta=float(req.fontDelta),
            )
        _job_update(job_id, status="done", stage="done", result=result, message="完成")
    except Exception as exc:  # noqa: BLE001
        _job_update(job_id, status="error", error=str(exc)[:300], message="失败")


@app.post("/translate/page")
def translate_page(req: TranslatePageRequest) -> dict:
    """重译译文 PDF 的指定页；同步返回（通常 10-60 秒）。"""
    if req.engine not in ("", "simple"):
        raise HTTPException(
            status_code=400, detail="单页重译只支持内置精译引擎；请先用同一引擎整篇翻译"
        )
    from .translate import retranslate_page

    return retranslate_page(
        req.path,
        req.outPath,
        req.page,
        req.targetLang,
        req.backend,
        req.baseUrl,
        req.apiKey,
        req.model,
        req.headers,
        max_workers=req.maxWorkers,
        mode=req.mode,
        layout=req.layout,
        glossary=req.glossary,
        auto_glossary=req.autoGlossary,
        no_think=req.noThink,
        font_delta=float(req.fontDelta),
    )


@app.post("/translate/start")
def translate_start(req: TranslateRequest) -> dict:
    _prune_jobs()
    job_id = uuid.uuid4().hex
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "status": "running",
            "stage": "analyzing",
            "done": 0,
            "total": 0,
            "message": "准备中",
            "result": None,
            "error": None,
            "cancel": False,
        }
    threading.Thread(target=_run_translate_job, args=(job_id, req), daemon=True).start()
    return {"jobId": job_id}


@app.get("/translate/status/{job_id}")
def translate_status(job_id: str) -> dict:
    with _JOBS_LOCK:
        j = dict(_JOBS.get(job_id) or {})
    if not j:
        raise HTTPException(status_code=404, detail="未知翻译任务")
    return {
        "status": j.get("status"),
        "stage": j.get("stage"),
        "done": j.get("done", 0),
        "total": j.get("total", 0),
        "message": j.get("message"),
        "error": j.get("error"),
        "result": j.get("result"),
    }


@app.post("/translate/cancel/{job_id}")
def translate_cancel(job_id: str) -> dict:
    _job_update(job_id, cancel=True)
    return {"ok": True}


# ============ 页面编辑（PD 页面删除）：缩略图 / 删页 ============


class PdfThumbsRequest(BaseModel):
    path: str
    pages: list[int] = []
    width: int = 140


class PdfDeleteRequest(BaseModel):
    path: str
    outPath: str
    pages: list[int] = []


@app.post("/pdf/thumbs")
def pdf_thumbs(req: PdfThumbsRequest) -> dict:
    """渲染指定页的缩略图（base64 PNG），供删除前核对。

    只读原文件，不改任何内容；页码为 0 基。
    """
    import base64

    import fitz

    doc = fitz.open(req.path)
    try:
        total = doc.page_count
        want = [p for p in req.pages if 0 <= p < total] or list(range(total))
        out = []
        for i in want:
            page = doc[i]
            w = float(req.width)
            scale = max(0.1, w / max(1.0, page.rect.width))
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            out.append({"page": i, "png": base64.b64encode(pix.tobytes("png")).decode("ascii")})
        return {"pageCount": total, "thumbs": out}
    finally:
        doc.close()


@app.post("/pdf/delete-pages")
def pdf_delete_pages(req: PdfDeleteRequest) -> dict:
    """把源 PDF 去掉指定页后写到 outPath，返回保留页与旧→新页映射。

    约束：不允许删光所有页；任何失败都不动源文件（写临时文件再替换由主进程负责）。
    """
    import fitz

    doc = fitz.open(req.path)
    try:
        total = doc.page_count
        kill = sorted({int(p) for p in req.pages if 0 <= int(p) < total})
        if not kill:
            raise HTTPException(status_code=400, detail="没有可删除的页面")
        if len(kill) >= total:
            raise HTTPException(status_code=400, detail="不能删除全部页面，至少保留 1 页")
        mapping = []
        new_index = 0
        for i in range(total):
            if i in kill:
                mapping.append(-1)
            else:
                mapping.append(new_index)
                new_index += 1
        doc.delete_pages(kill)
        doc.save(req.outPath, garbage=3, deflate=True)
        return {"pageCount": doc.page_count, "removed": kill, "pageMap": mapping}
    finally:
        doc.close()
