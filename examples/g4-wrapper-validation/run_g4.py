"""在受限容器内执行 G4 正例、原生入口、静态选择和三种隔离负控。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import xml.etree.ElementTree as ET

SOURCE_COMMIT = "6f0f185a691c16b0134a26f2ff172c7e2af31edb"
MODULE = "python/sglang/srt/layers/attention/dsv4/paged_mqa_pers_jit.py"
TEST = "test/registered/unit/layers/attention/dsv4/test_persistent_int8_paged_mqa_wrapper.py"
REGISTRY = "python/sglang/test/ci/ci_register.py"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def revision(root):
    # 明确涵盖新增测试及实际修改的产品文件，不以单个未含 untracked 的 diff 冒充身份。
    files = {name: sha(root / name) for name in (MODULE, TEST, REGISTRY)}
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest(), files


def execute(command, cwd, output, stem, environment):
    try:
        result = subprocess.run(command, cwd=cwd, env=environment, capture_output=True,
                                text=True, timeout=90, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        save(output / (stem + ".timeout.json"), {"command": command, "status": "timeout"})
        raise
    log = output / (stem + ".log")
    log.write_text(result.stdout + "\n" + result.stderr, encoding="utf-8")
    return result, {"path": log.name, "sha256": sha(log)}


def pytest_run(root, output, stem, environment, config):
    xml = output / (stem + ".xml")
    command = [sys.executable, "-I", "-B", "-m", "pytest", "--noconftest", "-p", "no:cacheprovider",
               "-c", str(config), "--rootdir", str(root), str(root / TEST), "--junitxml", str(xml), "-q"]
    result, log = execute(command, root, output, stem, environment)
    if not xml.is_file():
        raise RuntimeError("pytest 未生成 JUnit；不能当作有效测例结果")
    cases = []
    failures = {}
    for case in ET.parse(xml).getroot().iter("testcase"):
        test_id = case.get("classname") + "::" + case.get("name")
        failed, error, skipped = case.find("failure"), case.find("error"), case.find("skipped")
        outcome = "error" if error is not None else "failed" if failed is not None else "skipped" if skipped is not None else "passed"
        cases.append({"id": test_id, "outcome": outcome})
        if failed is not None:
            failures[test_id] = {"type": failed.get("type"), "message": failed.get("message"), "trace": failed.text}
    counts = {"tests": len(cases), "failed": sum(c["outcome"] == "failed" for c in cases),
              "errors": sum(c["outcome"] == "error" for c in cases), "skipped": sum(c["outcome"] == "skipped" for c in cases)}
    patch_hash, hashes = revision(root)
    data = {"source_commit": SOURCE_COMMIT, "patch_sha256": patch_hash,
            "patch_identity_mode": "sha256_of_canonical_executed_source_and_new_test_hash_manifest",
            "source_files": hashes, "command": command, "exit_code": result.returncode,
            "status": "pass" if result.returncode == 0 else "test_failure" if result.returncode == 1 and not counts["errors"] else "environment_or_collection_error",
            "counts": counts, "cases": cases, "assertion_failures": failures,
            "raw_artifacts": [log, {"path": xml.name, "sha256": sha(xml)}]}
    save(output / (stem + ".json"), data)
    return data


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--work", type=Path, required=True)
    args = p.parse_args()
    input_root, output, work = args.input.resolve(), args.output.resolve(), args.work.resolve()
    work.mkdir(parents=True, exist_ok=False)
    output.mkdir(parents=True, exist_ok=True)
    root = work / "checkout"
    root.mkdir()
    # Archive 为本地固定 Git 对象导出；拒绝穿越和链接，不接受任意用户 tar。
    with tarfile.open(input_root / "source.tar") as archive:
        for item in archive.getmembers():
            target = (root / item.name).resolve()
            if root not in target.parents or item.issym() or item.islnk() or not (item.isdir() or item.isfile()):
                raise RuntimeError("源码归档路径或类型不安全")
        archive.extractall(root)
    target = root / TEST
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(input_root / Path(TEST).name, target)
    original = (root / MODULE).read_text(encoding="utf-8")
    environment = {key: value for key, value in os.environ.items() if key in
                   ("PATH", "LD_LIBRARY_PATH", "HOME", "LANG", "LC_ALL", "DTK_HOME", "HYHAL_HOME")}
    environment.update({"PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1", "CUDA_VISIBLE_DEVICES": "-1",
                        "HIP_VISIBLE_DEVICES": "-1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"})
    import torch
    metadata = {"python": sys.version, "torch": torch.__version__, "hip_build": torch.version.hip,
                "cuda_build": torch.version.cuda, "device_initialized_before": torch.cuda.is_initialized(),
                "source_commit": SOURCE_COMMIT, "archive_sha256": sha(input_root / "source.tar"),
                "environment_scope": "CPU tensors, hidden devices, no kernel/JIT execution"}
    save(output / "environment.json", metadata)
    baseline = pytest_run(root, output, "positive", environment, input_root / "pytest.ini")
    if baseline["exit_code"] != 0 or baseline["counts"] != {"tests": 4, "failed": 0, "errors": 0, "skipped": 0}:
        raise RuntimeError("正例未完整通过：保留日志，不运行负控")
    command = [sys.executable, "-I", "-B", str(root / TEST), "-f"]
    native, log = execute(command, root, output, "native", environment)
    save(output / "native.json", {"command": command, "exit_code": native.returncode,
                                   "source_commit": SOURCE_COMMIT, "patch_sha256": baseline["patch_sha256"], "raw_artifacts": [log]})
    if native.returncode:
        raise RuntimeError("原生 unittest 文件入口失败")
    command = [sys.executable, "-I", "-B", str(root / "test/run_suite.py"), "--hw", "cpu", "--suite", "base-a-test-cpu",
               "--include-file", TEST.removeprefix("test/"), "--list"]
    selected, log = execute(command, root, output, "selection", environment)
    save(output / "selection.json", {"source_commit": SOURCE_COMMIT, "patch_sha256": baseline["patch_sha256"],
        "lane": "pr-cpu", "command": command, "exit_code": selected.returncode,
        "status": "local_static_selection" if selected.returncode == 0 else "selection_blocked",
        "selected_ids": [c["id"] for c in baseline["cases"]] if selected.returncode == 0 and Path(TEST).name in selected.stdout else [],
        "unresolved_gates": ["未取得真实 CPU workflow 的触发/gate/matrix 和本次 CI 执行身份"], "raw_artifacts": [log]})
    mutations = [
        ("remove_width_guard", "if max_seq_len <= 0 or max_seq_len % 64 != 0:", "if False:  # 故障注入：禁用宽度防卫", "test_rejects_unaligned_width_before_jit"),
        ("remove_reshape", "q = q.reshape(q.shape[0], q.shape[-2], q.shape[-1])", "q = q  # 故障注入：不转换4D", "test_forwards_4d_query_values_and_exact_arguments"),
        ("ignore_num_sms", "int(num_sms),", "320,  # 故障注入：忽略调用方参数", "test_forwards_4d_query_values_and_exact_arguments"),
    ]
    controls = []
    for name, old, new, expected_method in mutations:
        if original.count(old) != 1:
            raise RuntimeError("故障注入目标不唯一或源码版本变化")
        mutant = work / name
        for file in (MODULE, TEST, REGISTRY):
            dest = mutant / file
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / file, dest)
        (mutant / MODULE).write_text(original.replace(old, new), encoding="utf-8")
        result = pytest_run(mutant, output, name, environment, input_root / "pytest.ini")
        if result["exit_code"] != 1 or result["counts"]["errors"] or result["counts"]["skipped"] or not any(
                c["id"].endswith("::" + expected_method) and c["outcome"] == "failed" for c in result["cases"]):
            raise RuntimeError("负控不是目标断言失败，不可计作抓错成功")
        controls.append({"mutation": name, "target_method": expected_method,
                         "patch_sha256": result["patch_sha256"], "counts": result["counts"]})
    metadata["device_initialized_after"] = torch.cuda.is_initialized()
    save(output / "environment.json", metadata)
    summary = {"status": "local_cpu_positive_and_negative_controls_passed", "source_commit": SOURCE_COMMIT,
               "positive": baseline["counts"], "native_exit_code": native.returncode,
               "selection_exit_code": selected.returncode, "negative_controls": controls,
               "actual_ci_executed": False, "hcu_kernel_executed": False, "original_gap_closed": False}
    save(output / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=True))


if __name__ == "__main__":
    main()
