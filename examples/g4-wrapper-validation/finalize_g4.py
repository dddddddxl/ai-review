"""核对下载的真实工件并生成 G4 完成记录，不生成或篡改执行结果。"""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--validator-commit", required=True, help="本次 completion v2 校验器的完整 Git SHA")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.validator_commit):
        parser.error("validator-commit 必须是完整的 40 位 Git SHA")
    root = args.bundle.resolve()
    artifact_root = root / "artifacts"
    plan = load(root / "generation-plan.json")
    positive = load(artifact_root / "positive.json")
    environment = load(artifact_root / "environment.json")
    task, = plan["tasks"]
    assert task["id"] == "G4"
    assert positive["source_commit"] == plan["source_commit"]
    assert positive["counts"] == dict(tests=4, failed=0, errors=0, skipped=0)
    assert positive["exit_code"] == 0 and positive["status"] == "pass"
    assert all(case["outcome"] == "passed" for case in positive["cases"])
    test_name = "test_persistent_int8_paged_mqa_wrapper.py"
    test_path = "test/registered/unit/layers/attention/dsv4/" + test_name
    assert sha(root / test_name) == positive["source_files"][test_path]
    manifest = json.dumps(positive["source_files"], sort_keys=True).encode()
    assert hashlib.sha256(manifest).hexdigest() == positive["patch_sha256"]
    assert not environment["device_initialized_before"]
    assert not environment["device_initialized_after"]
    # 工件必须已完整取回，不能只保留一个退出码或重写原始日志。
    for path in artifact_root.glob("*.json"):
        data = load(path)
        for ref in data.get("raw_artifacts", []):
            raw = (artifact_root / ref["path"]).resolve()
            assert artifact_root in raw.parents and sha(raw) == ref["sha256"]

    # 保存独立解释工件：pytest subTest 的 suite 汇总不等于方法级 case 数。
    # 原始 JSON/XML/日志保持不变，方法结果必须能从实际 testcase 节点重新得到。
    count_records = []
    for stem in ("positive", "remove_width_guard", "remove_reshape", "ignore_num_sms"):
        result = load(artifact_root / (stem + ".json"))
        xml_path = artifact_root / (stem + ".xml")
        xml_root = ET.parse(xml_path).getroot()
        cases = []
        for case in xml_root.iter("testcase"):
            outcome = "error" if case.find("error") is not None else "failed" if case.find("failure") is not None else "skipped" if case.find("skipped") is not None else "passed"
            cases.append(dict(id=case.get("classname") + "::" + case.get("name"), outcome=outcome))
        assert cases == result["cases"]
        count_records.append(dict(
            run=stem, source_commit=result["source_commit"], patch_sha256=result["patch_sha256"],
            junit_suite_summaries=[dict(s.attrib) for s in xml_root.iter("testsuite")],
            method_counts=result["counts"], failure_nodes=len(list(xml_root.iter("failure"))),
            raw_artifact=dict(path=xml_path.name, sha256=sha(xml_path)),
        ))
    count_artifact = dict(
        kind="derived_from_original_junit", counting_unit="method_testcase",
        explanation="一个 unittest 方法可有多个 subTest 失败节点；方法存在任一 failure 即记 failed。保留原始 suite 汇总，不用 console passed 数覆盖方法失败。",
        records=count_records,
        raw_artifacts=[dict(path=stem + ".xml", sha256=sha(artifact_root / (stem + ".xml")))
                       for stem in ("positive", "remove_width_guard", "remove_reshape", "ignore_num_sms")],
    )
    (artifact_root / "result-counting.json").write_text(json.dumps(count_artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    revision = {key: positive[key] for key in ("source_commit", "patch_sha256")}
    controls = []
    definitions = [
        ("remove_width_guard", "test_rejects_unaligned_width_before_jit", "NC_WIDTH",
         "在隔离副本禁用非法宽度防卫", "非法宽度必须抛 ValueError；工厂和后端不得被调用"),
        ("remove_reshape", "test_forwards_4d_query_values_and_exact_arguments", "NC_RESHAPE",
         "在隔离副本删除 4D→3D reshape", "后端 Q 必须为 (2,64,128)，不能保留单例维度"),
        ("ignore_num_sms", "test_forwards_4d_query_values_and_exact_arguments", "NC_SMS",
         "在隔离副本以 320 替代调用方 num_sms=17", "后端参数尾部必须严格等于 (width,17,0)"),
    ]
    references = [("POS", "positive"), ("NATIVE", "native"), ("SEL", "selection"),
                  ("ENV", "environment"), ("SUMMARY", "summary"), ("COUNTING", "result-counting")]
    for stem, method, ref_id, mutation, target in definitions:
        result = load(artifact_root / (stem + ".json"))
        case, = [case for case in result["cases"] if case["id"].endswith("::" + method)]
        assert case["outcome"] == "failed"
        assert result["exit_code"] == 1 and result["status"] == "test_failure"
        assert result["counts"]["errors"] == result["counts"]["skipped"] == 0
        assert result["source_commit"] == revision["source_commit"]
        assert result["patch_sha256"] != revision["patch_sha256"]
        failure = result["assertion_failures"][case["id"]]
        # pytest 的 JUnit failure 节点不保证提供 type；不补造字段。
        assert "AssertionError" in (failure.get("trace") or "")
        references.append((ref_id, stem))
        controls.append(dict(
            scenario_id="G4-width", test_id=case["id"], baseline_evidence="POS",
            tested_revision={key: result[key] for key in revision}, mutation=mutation,
            target_assertion=target, failure_kind="target_assertion", evidence=ref_id,
            agent_review="Codex 已阅读原始失败日志：目标断言失败，非导入/setup 错误；未经人类独立复核",
        ))
    selected = load(artifact_root / "selection.json")
    assert selected["status"] == "selection_blocked" and selected["exit_code"] == 1
    assert load(artifact_root / "native.json")["exit_code"] == 0
    data = dict(
        schema_version=2, repository=plan["repository"], audit_source_commit=plan["source_commit"],
        evidence=[dict(id=ref_id, path="artifacts/" + stem + ".json",
                       sha256=sha(artifact_root / (stem + ".json"))) for ref_id, stem in references],
        tasks=[dict(
            task_id="G4", status="implemented_unverified",
            validated_scope="仅验证固定提交的 CPU 包装器宽度防卫、4D→3D 和参数转发；不包含真实 CI、HCU 数值、graph 或生产路由",
            tested_revision=revision,
            scenario_results=[dict(scenario_id="G4-width", tests=[
                dict(test_id=case["id"], outcome=case["outcome"], evidence="POS")
                for case in positive["cases"]
            ])],
            acceptance_results=[
                dict(condition=task["acceptance"][0], status="met", evidence=["POS", "NATIVE", "NC_WIDTH", "NC_RESHAPE", "NC_SMS"]),
                dict(condition=task["acceptance"][1], status="unmet", evidence=["SEL"],
                     reason="全局注册校验在 include-file 过滤前发现两个已有无效 CPU suite，选择器退出；未获得真实 CI 运行身份"),
            ],
            negative_controls=controls, ci_selection="SEL", ci_execution=None,
            unresolved_prerequisites=[
                "原生 CPU selector 被两个已有 stage-a-test-cpu 注册阻塞；未改动无关测试",
                "尚未核对完整 workflow 的触发/gate/matrix，未执行真实 CPU CI",
            ],
            disposition="write_original", framework="unittest.TestCase；pytest 运行同一类，并实测原生 python 文件入口 -f",
            test_paths=[test_path], environment=dict(
                evidence="ENV", image="sha256:3ba7d7248f7e082e179f3b8064104232d6fcb5fa3f4398cb0e641810ee6b978f",
                cpus=1, memory_bytes=2147483648, network="none", privileged=False,
                devices=[], readonly_root=True, installation="镜像已有 PyTorch；未安装或更新节点依赖",
            ),
            upstream=dict(
                repository="https://github.com/sgl-project/sglang",
                revision="25f2e430acb914c793307a5139b9b2a2055a2547",
                revision_basis="目标仓库 THIRD_PARTY_NOTICES 的声明基线，不代表当前上游 head",
                search_status="GitHub 上游树查询不可用，不能断言不存在可复用上游测试",
                local_search="固定 head 下 test 与 python/sglang/test 的包装器/入口名检索未找到直接测试；已检查 DSA 及 DSV4 候选，不是全仓语义穷举",
                copied_source=False, test_license="Apache-2.0",
            ),
            rationale="沿用仓库原生 unittest 风格。导入真实文件，使用真实 CPU 张量，仅替换 JIT 工厂；不复制被测函数，也不加载完整服务。",
            patch_identity_mode=positive["patch_identity_mode"],
            patch_identity_limitation="该身份是实际执行文件哈希清单，不是 git diff 的 SHA256；测试文件为新增文件，安装 wheel 不充当产品源码",
            authorization="用户授权生成、隔离实测及将本轮脱敏产物推送个人 fork；不修改业务仓库/CI、不发布业务评论",
        )],
        provenance=dict(generation_skill_commit="aaff435e1eb80e4e187b9b71bd0a39a442f6327e",
                        completion_validator_commit=args.validator_commit,
                        schema_migration="v1_to_v2_without_reexecuting_or_modifying_original_run_artifacts",
                        source_archive_sha256=environment["archive_sha256"],
                        archive_scope="固定 Git 对象的包装器、注册模块、原生选择器、registered 测试目录和许可证；未打包模型/凭据"),
    )
    (root / "completion.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # 发布候选是自动生成的单文件补丁，不修改原始目标 checkout。
    test_lines = (root / test_name).read_text(encoding="utf-8").splitlines(keepends=True)
    diff = "diff --git a/" + test_path + " b/" + test_path + "\nnew file mode 100644\n"
    diff += "".join(difflib.unified_diff([], test_lines, fromfile="/dev/null", tofile="b/" + test_path))
    (root / "g4-test.patch").write_text(diff, encoding="utf-8", newline="\n")
    print(json.dumps(dict(status="bundle_verified", task_status="implemented_unverified",
                          artifacts=len(references), original_gap_closed=False), ensure_ascii=False))


if __name__ == "__main__":
    main()
