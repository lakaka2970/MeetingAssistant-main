#!/usr/bin/env python3
"""Build the pre-chunked interview KB consumed by the app's lexical channel.

Sources (author boundaries preserved — never re-sliding-windowed):
  * 基础面经19_上_核心知识点整理.pdf  → one chunk per numbered knowledge point
    (核心答案+要点+记忆锚点+易错追问 kept whole; ★重点→P0)
  * 基础面经19_上.pdf                → one chunk per question, watermark-cleaned
    (原文详解与代码示例, supplements the summary)
  * ros_learn/课程学习总结/*.md      → one chunk per ## section
  * ros_learn/课程学习总结/code/*    → one chunk per file (docstring heads the stem)

Output layout (matches tools/kb-eval.ts and rag/kbRetrieval.ts conventions):
  <OUT>/99_元数据与检索/991_index.jsonl
  <OUT>/99_元数据与检索/_rag/index/bm25_meta.json   (term aliases, +MRR)
  <OUT>/99_元数据与检索/_rag/golden.jsonl           (retrieval eval set)
  <OUT>/sources/ROS/*.md                            (copies, for the sliding-window baseline)

Run: python3 tools/build-interview-kb.py [outDir]
"""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SUMMARY_PDF = Path("/home/lzy/Documents/MyWork/My-Interview/易道云/面经/基础面经19_上_核心知识点整理.pdf")
ORIGINAL_PDF = Path("/home/lzy/Documents/MyWork/My-Interview/易道云/面经/基础面经19_上.pdf")
ROS_DIR = Path("/home/lzy/Documents/MyWork/ros_learn/课程学习总结")
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/home/lzy/Documents/MyWork/MeetingAssistant-KB")
META = OUT / "99_元数据与检索"

CHAPTERS = {"一": "C++ 基础", "二": "C++11 新特性", "三": "STL 容器", "四": "计算机网络",
            "五": "操作系统", "六": "数据结构与算法", "七": "设计模式"}
DOMAIN_BY_CHAPTER = {"C++ 基础": "C++", "C++11 新特性": "C++11", "STL 容器": "STL",
                     "计算机网络": "计算机网络", "操作系统": "操作系统",
                     "数据结构与算法": "算法", "设计模式": "设计模式"}
# watermark of the original PDF: single chars of 易道云信息技术研究院 scattered by layout
WATERMARK = re.compile(r"^[究院研术易道云信息技]$")
QUESTION = re.compile(r"^(\d+)[\.、]\s*(\S.*)$")


def looks_like_title(t: str) -> bool:
    # guards against numeric body lines ("0.25: …", "2.5") being read as questions
    return bool(re.search(r"[一-鿿A-Za-z？?]", t)) and len(t) > 3


def is_question_header(title: str, next_line: str, mode: str) -> bool:
    """Real question headers vs numbered list items inside an answer body.

    List items are declarative and end with 。; questions end with ？/? or carry
    an interrogative word. The summary additionally follows every real question
    with a structural marker (核心答案 / ★重点 / 常考 / ○了解), which is the
    strongest signal there.
    """
    if title.endswith(("。", "；", "，", "、", "：")):
        return False
    if title.endswith(("？", "?")):
        return True
    if mode == "summary":
        return bool(re.match(r"^(核心答案|★|◆|常考|○|了解)", next_line))
    return bool(re.search(r"(什么|为什么|如何|怎么|哪些|区别|吗|呢|能否|是否|多少)", title))


def pdftotext(pdf: Path) -> str:
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
        tmp = f.name
    subprocess.run(["pdftotext", str(pdf), tmp], check=True)
    return Path(tmp).read_text(encoding="utf-8", errors="replace")


def split_questions(text: str, clean_watermark: bool, mode: str):
    out, cur, chapter = [], None, ""
    expected = 1  # questions number sequentially per chapter; body lists restart at 1
    lines = text.replace("\f", "\n").split("\n")
    for i, ln in enumerate(lines):
        s = ln.strip()
        m = re.match(r"^第([一二三四五六七])章", s)
        if m:
            chapter = CHAPTERS[m.group(1)]
            expected = 1
            continue
        if clean_watermark and (WATERMARK.match(s) or "学员专用" in s or s.startswith("《最全面")):
            continue
        q = QUESTION.match(s)
        if q and q.group(1) != "0" and looks_like_title(q.group(2)):
            nxt = next((x.strip() for x in lines[i + 1:] if x.strip()), "")
            t = q.group(2).strip()
            sequential = int(q.group(1)) == expected and not t.endswith(("。", "；", "，", "、", "："))
            if is_question_header(t, nxt, mode) or sequential:
                if cur:
                    out.append(cur)
                cur = {"num": q.group(1), "title": q.group(2).strip(), "body": [], "chapter": chapter}
                expected = int(q.group(1)) + 1
                continue
        if cur is not None:
            cur["body"].append(ln)
    if cur:
        out.append(cur)
    return out


def chunk(doc_id, title, path, section, text, *, layer, doc_type, domain, priority="P1",
          chapter="", scenarios=(), evidence=()):
    text = text.strip()
    return {
        "chunk_id": f"{doc_id}-{hashlib.sha1(text.encode()).hexdigest()[:10]}",
        "doc_id": doc_id,
        "title": title,
        "path": str(path),
        "section": section,
        "doc_type": doc_type,
        "job_primary": "面试",
        "job_secondary": ["C++", "ROS2"],
        "layer": layer,
        "domain": domain,
        "scenarios": list(scenarios),
        "evidence": list(evidence),
        "priority": priority,
        "status": "ready",
        "breadcrumb": [title, chapter, section],
        "text": text,
        "n_chars": len(text),
        "hash": hashlib.sha1(text.encode()).hexdigest()[:16],
    }


def ascii_terms(s: str):
    return re.findall(r"[A-Za-z_][A-Za-z0-9_]{1,}", s)


def build_pdf_chunks():
    chunks = []
    summary = pdftotext(SUMMARY_PDF)
    for q in split_questions(summary, clean_watermark=False, mode="summary"):
        body = "\n".join(q["body"]).strip()
        text = f"{q['num']}. {q['title']}\n{body}"
        prio = "P0" if re.search(r"★\s*重点", body) else ("P2" if re.search(r"○\s*了解|^了解$", body, re.M) else "P1")
        dom = DOMAIN_BY_CHAPTER.get(q["chapter"], "C++")
        chunks.append(chunk("MJ19S", "基础面经19（上）核心知识点整理", SUMMARY_PDF,
                            f"{q['num']}. {q['title']}"[:80], text,
                            layer="通用基础层", doc_type="八股整理", domain=dom, priority=prio,
                            chapter=q["chapter"], scenarios=[dom, *ascii_terms(q["title"])],
                            evidence=[str(SUMMARY_PDF)]))
    original = pdftotext(ORIGINAL_PDF)
    for q in split_questions(original, clean_watermark=True, mode="original"):
        body = "\n".join(q["body"]).strip()
        text = f"{q['num']}. {q['title']}（原文详解）\n{body}"
        dom = DOMAIN_BY_CHAPTER.get(q["chapter"], "C++")
        chunks.append(chunk("MJ19O", "基础面经19（上）原文", ORIGINAL_PDF,
                            f"{q['num']}. {q['title']}"[:80], text,
                            layer="通用基础层", doc_type="八股原文", domain=dom, priority="P1",
                            chapter=q["chapter"], scenarios=[dom, *ascii_terms(q["title"])],
                            evidence=[str(ORIGINAL_PDF)]))
    return chunks


def build_ros_chunks():
    chunks = []
    project_docs = {"10", "11", "13"}
    for md in sorted(ROS_DIR.glob("*.md")):
        num = md.stem[:2]
        text = md.read_text(encoding="utf-8")
        m = re.search(r"^#\s+(.+)$", text, re.M)
        title = m.group(1).strip() if m else md.stem
        layer = "个人资产层" if num in project_docs else "通用基础层"
        parts = re.split(r"^(##\s+.+)$", text, flags=re.M)
        pairs = [("_preamble", parts[0])] + [(parts[i][3:].strip(), parts[i + 1]) for i in range(1, len(parts) - 1, 2)]
        for section, body in pairs:
            body = body.strip()
            if len(body) < 80:
                continue
            dom = "ROS2"
            chunks.append(chunk(f"ROS{num}", title, md, section[:80], f"{section}\n{body}",
                                layer=layer, doc_type="课程笔记", domain=dom,
                                chapter="ROS2 课程", scenarios=[dom, *ascii_terms(section)],
                                evidence=[str(md)]))
    code_dir = ROS_DIR / "code"
    for f in sorted(code_dir.rglob("*")):
        if not f.is_file() or f.suffix not in {".py", ".sh", ".cpp", ".xml", ".txt", ".md"}:
            continue
        rel = f.relative_to(ROS_DIR)
        content = f.read_text(encoding="utf-8", errors="replace")
        chunks.append(chunk("ROSCODE", "ROS2 课程示例代码", f, f.name[:80],
                            f"{f.name}（{rel}，本机 Jazzy 实测）\n{content}",
                            layer="个人资产层", doc_type="示例代码", domain="ROS2",
                            chapter="ROS2 课程", scenarios=["ROS2", f.stem, *ascii_terms(f.name)],
                            evidence=[str(f)]))
    return chunks


ALIASES = {
    "shared_ptr": ["智能指针", "引用计数", "控制块", "shared_count", "weak_ptr"],
    "智能指针": ["shared_ptr", "unique_ptr", "weak_ptr", "RAII"],
    "虚函数": ["虚表", "vtable", "vptr", "多态", "动态绑定", "重写"],
    "多态": ["虚函数", "重载", "重写", "静态多态", "动态多态"],
    "三次握手": ["TCP", "SYN", "ACK", "连接建立", "两次握手"],
    "四次挥手": ["TCP", "FIN", "TIME_WAIT", "CLOSE_WAIT"],
    "tcp": ["三次握手", "四次挥手", "拥塞控制", "流量控制", "滑动窗口"],
    "进程": ["线程", "协程", "IPC", "进程间通信", "调度"],
    "线程": ["进程", "同步", "互斥", "锁", "死锁", "条件变量"],
    "死锁": ["互斥", "占有并等待", "不可抢占", "循环等待", "银行家算法"],
    "vector": ["扩容", "reserve", "resize", "迭代器失效", "push_back"],
    "map": ["红黑树", "unordered_map", "哈希表", "迭代器"],
    "哈希": ["hash", "冲突", "拉链法", "开放地址", "unordered_map"],
    "内存泄漏": ["valgrind", "ASAN", "检测", "RAII", "智能指针"],
    "堆栈": ["堆", "栈", "内存分配", "malloc", "new", "碎片", "栈溢出"],
    "epoll": ["IO多路复用", "select", "poll", "LT", "ET", "reactor"],
    "http": ["HTTPS", "TLS", "状态码", "GET", "POST"],
    "https": ["TLS", "SSL", "证书", "加密", "握手"],
    "单例": ["设计模式", "懒汉", "饿汉", "双重检查", "线程安全"],
    "lambda": ["捕获", "闭包", "匿名函数", "C++11"],
    "移动语义": ["右值引用", "std::move", "完美转发", "RVO"],
    "qos": ["服务质量", "transient_local", "volatile", "reliable", "best_effort", "durability"],
    "地图": ["/map", "OccupancyGrid", "slam_toolbox", "map_server", "QoS"],
    "tf": ["TF2", "坐标变换", "lookupTransform", "tf_static", "四元数"],
    "slam": ["建图", "slam_toolbox", "cartographer", "定位", "地图"],
    "导航": ["Nav2", "路径规划", "避障", "costmap", "AMCL"],
    "探索": ["前沿", "frontier", "BFS", "聚簇", "净空", "自主探索"],
    "urdf": ["xacro", "建模", "link", "joint", "机器人模型"],
    "gazebo": ["仿真", "传感器", "插件", "world"],
    "话题": ["topic", "发布", "订阅", "消息", "通信"],
    "服务": ["service", "参数", "action", "动作", "通信"],
    "colcon": ["工作空间", "编译", "build", "launch"],
    "launch": ["启动", "节点", "参数", "colcon"],
    # 跨域消歧：词法通道会把 costmap 的 map 撞 C++ map、观察者撞工厂，
    # 别名把正确领域的判别词补进查询，配合稠密通道纠正错配
    "观察者": ["observer", "发布订阅", "通知", "行为型", "Subject", "attach"],
    "costmap": ["代价地图", "膨胀", "inflation", "导航", "Nav2", "ROS"],
    "膨胀": ["inflation", "costmap", "代价地图", "障碍"],
    "amcl": ["粒子滤波", "蒙特卡洛", "定位", "likelihood", "ROS"],
    "内存对齐": ["alignment", "alignof", "padding", "字节对齐"],
    "页表": ["虚拟内存", "page table", "TLB", "缺页", "内存管理"],
    "tls": ["握手", "证书", "加密", "HTTPS", "SSL"],
}

GOLDEN = [
    {"q": "C++ shared_ptr 是线程安全的吗", "expectDocs": ["MJ19S", "MJ19O"], "expectKeywords": ["引用计数", "原子"]},
    {"q": "TCP 为什么三次握手不是两次", "expectDocs": ["MJ19S", "MJ19O"], "expectKeywords": ["SYN"]},
    {"q": "vector 扩容机制和迭代器失效", "expectDocs": ["MJ19S", "MJ19O"], "expectKeywords": ["扩容"]},
    {"q": "epoll 和 select 的区别", "expectDocs": ["MJ19S", "MJ19O"], "expectKeywords": ["epoll"]},
    {"q": "死锁的四个必要条件", "expectDocs": ["MJ19S", "MJ19O"], "expectKeywords": ["循环等待"]},
    {"q": "单例模式线程安全写法", "expectDocs": ["MJ19S", "MJ19O"], "expectKeywords": ["单例"]},
    {"q": "订阅 /map 收不到地图 QoS 原因", "expectDocs": ["ROS01"], "expectKeywords": ["transient_local"]},
    {"q": "lookupTransform 参数顺序 target source", "expectDocs": ["ROS04"], "expectKeywords": ["target"]},
    {"q": "前沿探索怎么选目标点 路径距离 净空", "expectDocs": ["ROS13"], "expectKeywords": ["净空"]},
    {"q": "URDF xacro 建模 link joint", "expectDocs": ["ROS05"], "expectKeywords": ["xacro"]},
    {"q": "slam_toolbox 建图命令", "expectDocs": ["ROS08"], "expectKeywords": ["slam_toolbox"]},
    {"q": "Nav2 导航避障 costmap", "expectDocs": ["ROS09"], "expectKeywords": ["Nav2"]},
    {"q": "colcon 工作空间编译", "expectDocs": ["ROS03"], "expectKeywords": ["colcon"]},
    {"q": "OccupancyGrid PGM 行序换算", "expectDocs": ["ROS08", "ROSCODE"], "expectKeywords": ["PGM"]},
    {"q": "action 通信 反馈 取消", "expectDocs": ["ROS02", "ROSCODE"], "expectKeywords": ["feedback"]},
    {"q": "map_server free_thresh 未知灰 205", "expectDocs": ["ROS08", "ROSCODE"], "expectKeywords": ["0.196"]},
    {"q": "观察者模式的设计意图", "expectDocs": ["MJ19S", "MJ19O"], "expectKeywords": ["观察者", "通知"]},
    {"q": "costmap 膨胀层的作用", "expectDocs": ["ROS09", "ROS13"], "expectKeywords": ["膨胀"]},
    {"q": "AMCL 定位原理", "expectDocs": ["ROS09", "ROS08"], "expectKeywords": ["粒子滤波"]},
    {"q": "C++ 内存对齐规则", "expectDocs": ["MJ19S", "MJ19O"], "expectKeywords": ["对齐"]},
    {"q": "虚拟内存页表作用", "expectDocs": ["MJ19S", "MJ19O"], "expectKeywords": ["页表"]},
]


def main():
    META.mkdir(parents=True, exist_ok=True)
    (META / "_rag" / "index").mkdir(parents=True, exist_ok=True)
    chunks = build_pdf_chunks() + build_ros_chunks()
    with open(META / "991_index.jsonl", "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    (META / "_rag" / "index" / "bm25_meta.json").write_text(
        json.dumps({"aliases": ALIASES}, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(META / "_rag" / "golden.jsonl", "w", encoding="utf-8") as f:
        for g in GOLDEN:
            f.write(json.dumps({"q": g["q"], "expect_docs": g["expectDocs"],
                                "expect_keywords": g["expectKeywords"]}, ensure_ascii=False) + "\n")
    src = OUT / "sources" / "ROS"
    src.mkdir(parents=True, exist_ok=True)
    for md in sorted(ROS_DIR.glob("*.md")):
        shutil.copy2(md, src / md.name)
    by_doc = {}
    for c in chunks:
        by_doc[c["doc_id"]] = by_doc.get(c["doc_id"], 0) + 1
    print(f"[build-kb] {len(chunks)} chunks / {len(by_doc)} docs -> {META / '991_index.jsonl'}")
    for d, n in sorted(by_doc.items()):
        print(f"  {d}: {n}")


if __name__ == "__main__":
    main()