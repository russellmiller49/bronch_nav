"""Directional candidate rules for bronchial branch tracing.

The engine in this module intentionally produces candidate labels, not final
anatomical assignments. It uses parent context and directional evidence to rank
plausible labels while keeping uncertainty and review reasons in the result.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from statistics import median
from typing import Any, Iterable, Mapping, Sequence

import yaml


BOOK_RULE_SOURCE = "book_directional_rules"
SEGMENTAL_PARENT_CONFIDENCE_THRESHOLD = 0.75
AMBIGUOUS_SCORE_THRESHOLD = 0.55


@dataclass(frozen=True)
class DirectionEvidence:
    edge_vector: list[float]
    coordinate_system: str
    side: str
    anatomical_components: dict[str, float]
    expected_terms: list[str]
    score: float
    warnings: list[str]


@dataclass(frozen=True)
class CandidateRule:
    label: str
    candidate_level: str
    lung_side: str
    section: str
    parent_context_labels: list[str]
    expected_direction_terms: list[str]
    sibling_context: list[str]
    metadata: dict[str, Any]


@dataclass(frozen=True)
class CandidateResult:
    edge_id: int | str
    candidate_label: str
    candidate_level: str
    score: float
    evidence: dict[str, Any]
    explanation: str
    warnings: list[str]
    source: str = BOOK_RULE_SOURCE


def default_candidate_rules_path() -> Path:
    return Path(__file__).resolve().parents[1] / "labels" / "bronchial_branch_tracing_candidates.yaml"


def load_candidate_rules(yaml_path: str | Path | None = None) -> dict[str, Any]:
    """Load bronchial branch tracing candidate rules from YAML."""

    path = Path(yaml_path) if yaml_path is not None else default_candidate_rules_path()
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Candidate rules YAML must contain a mapping: {path}")
    return payload


def generate_segmental_candidates(graph: Any, hierarchy: Mapping[str, Any] | None, rules: Mapping[str, Any]) -> list[CandidateResult]:
    return CandidateRuleEngine(rules).generate_segmental_candidates(graph, hierarchy)


def generate_subsegmental_candidates(graph: Any, hierarchy: Mapping[str, Any] | None, rules: Mapping[str, Any]) -> list[CandidateResult]:
    return CandidateRuleEngine(rules).generate_subsegmental_candidates(graph, hierarchy)


def detect_lateral_branch(edge: Any, parent_edge: Any, sibling_edges: Sequence[Any]) -> CandidateResult | None:
    """Detect a small steep daughter branch and label it as parent_label + "*".

    The lateral-branch convention does not increment generation. This function
    only returns a candidate when the size and angle evidence are strong enough
    to justify review as a lateral daughter branch.
    """

    parent_label = _edge_label_from_any(parent_edge)
    if not parent_label:
        return None

    siblings = [item for item in sibling_edges if _edge_id(item) != _edge_id(edge)]
    if not siblings:
        return None

    edge_radius = _edge_radius(edge)
    sibling_radii = [_edge_radius(item) for item in siblings if math.isfinite(_edge_radius(item))]
    counterpart_radius = max(sibling_radii) if sibling_radii else float("nan")
    diameter_ratio = edge_radius / counterpart_radius if math.isfinite(edge_radius) and math.isfinite(counterpart_radius) and counterpart_radius > 0 else float("nan")

    parent_vector = _edge_vector(parent_edge)
    edge_vector = _edge_vector(edge)
    angle = _angle_degrees(parent_vector, edge_vector)
    sibling_alignment = max((_cosine(parent_vector, _edge_vector(item)) for item in siblings), default=0.0)
    edge_alignment = _cosine(parent_vector, edge_vector)

    features: dict[str, Any] = {
        "diameter_ratio_to_counterpart": round(diameter_ratio, 4) if math.isfinite(diameter_ratio) else None,
        "branch_angle_degrees": round(angle, 2) if math.isfinite(angle) else None,
        "counterpart_radius_mm": round(counterpart_radius, 4) if math.isfinite(counterpart_radius) else None,
        "edge_radius_mm": round(edge_radius, 4) if math.isfinite(edge_radius) else None,
        "has_more_aligned_sibling": sibling_alignment > edge_alignment + 0.15,
    }
    small = math.isfinite(diameter_ratio) and diameter_ratio < 0.75
    steep = math.isfinite(angle) and angle >= 35.0
    side_branch = bool(features["has_more_aligned_sibling"])
    matched = [name for name, ok in {"small_daughter": small, "steep_angle": steep, "off_main_axis": side_branch}.items() if ok]

    if len(matched) < 2:
        return None

    score = min(0.98, 0.30 + 0.20 + 0.15 + 0.10 * len(matched))
    evidence = {
        "parent_label": parent_label,
        "lateral_branch_features": features,
        "matched_lateral_branch_features": matched,
        "generation_incremented": False,
        "needs_review": True,
    }
    return CandidateResult(
        edge_id=_edge_id(edge),
        candidate_label=f"{parent_label}*",
        candidate_level="variant",
        score=round(score, 4),
        evidence=evidence,
        explanation=(
            f"{parent_label}* candidate: daughter branch is smaller/steeper than a continuing sibling; "
            "generation is not incremented."
        ),
        warnings=["lateral_branch_candidate_not_final_label"],
    )


def score_direction(
    edge_vector: Sequence[float] | Mapping[str, float],
    expected_direction_terms: Sequence[str],
    side: str,
    coordinate_system: str,
) -> float:
    """Score directional agreement from 0 to 1.

    Raw RAS/LPS vectors and already-normalized anatomical component mappings are
    both accepted. Unknown coordinate systems return 0 because lateral/medial
    and ventral/dorsal signs are unsafe.
    """

    terms = [str(term) for term in expected_direction_terms or []]
    if not terms:
        return 0.0

    components = _anatomical_components(edge_vector, side=side, coordinate_system=coordinate_system)
    if not components:
        return 0.0

    term_weights = {
        "cranial": 1.0,
        "caudal": 1.0,
        "dorsal": 1.0,
        "ventral": 1.0,
        "lateral": 1.0,
        "medial": 1.0,
        "toward_lung_apex": 1.0,
        "horizontal": 0.6,
        "vertical": 0.6,
        "basal": 0.5,
        "superior_segment": 0.5,
        "posterior_basal": 0.5,
        "apical": 0.7,
    }
    compound_map = {
        "toward_lung_apex": ["cranial"],
        "apical": ["cranial"],
        "basal": ["caudal"],
        "superior_segment": ["dorsal", "cranial"],
        "posterior_basal": ["dorsal", "caudal"],
    }

    scores: list[float] = []
    for raw_term in terms:
        term = _normalize_direction_term(raw_term)
        if _is_non_direction_term(term):
            continue
        alternatives = term.split("_or_") if "_or_" in term else [term]
        option_scores: list[float] = []
        for alternative in alternatives:
            mapped = compound_map.get(alternative, [alternative])
            vals = [float(components.get(item, 0.0)) for item in mapped]
            raw = max(vals) if vals else 0.0
            option_scores.append(max(0.0, raw) * term_weights.get(alternative, term_weights.get(term, 1.0)))
        if option_scores:
            scores.append(max(option_scores))

    if not scores:
        return 0.0
    return round(min(1.0, sum(scores) / max(1.0, len(scores))), 4)


def score_sibling_order(edge: Any, sibling_edges: Sequence[Any], expected_sibling_context: Sequence[str]) -> float:
    """Score simple order clues like "more cranial than siblings" from 0 to 1."""

    siblings = [item for item in sibling_edges if _edge_id(item) != _edge_id(edge)]
    if not siblings:
        return 0.0
    context = " ".join(str(item).lower() for item in expected_sibling_context or [])
    if not context:
        return 0.5

    checks: list[float] = []
    edge_vector = _unit_vector(_edge_vector(edge))
    sibling_vectors = [_unit_vector(_edge_vector(item)) for item in siblings]

    axes = {
        "cranial": 2,
        "caudal": 2,
        "dorsal": 1,
        "ventral": 1,
    }
    for term, axis in axes.items():
        if f"more {term}" not in context:
            continue
        edge_value = edge_vector[axis]
        sibling_values = [item[axis] for item in sibling_vectors]
        if term in {"caudal", "dorsal"}:
            edge_value *= -1.0
            sibling_values = [-item for item in sibling_values]
        checks.append(_relative_rank_score(edge_value, sibling_values))

    if "lateral" in context and "more lateral" in context:
        checks.append(_relative_rank_score(abs(edge_vector[0]), [abs(item[0]) for item in sibling_vectors]))

    if not checks:
        return 0.5
    return round(sum(checks) / len(checks), 4)


def apply_hierarchy_constraints(candidate_results: Sequence[CandidateResult], hierarchy: Mapping[str, Any] | None) -> list[CandidateResult]:
    """Apply non-final-label safety constraints and populate review_queue."""

    mutable_hierarchy = hierarchy if isinstance(hierarchy, dict) else None
    out: list[CandidateResult] = []
    for result in candidate_results:
        evidence = dict(result.evidence)
        warnings = list(result.warnings)
        score = float(result.score)

        if evidence.get("parent_context_missing"):
            continue

        if result.candidate_level in {"subsegmental", "sub_subsegmental"}:
            parent_locked = bool(evidence.get("parent_locked"))
            parent_confidence = float(evidence.get("parent_confidence") or 0.0)
            if not parent_locked and parent_confidence < SEGMENTAL_PARENT_CONFIDENCE_THRESHOLD:
                continue
            if score > 0.85 and not evidence.get("direct_model_support") and not evidence.get("manual_confirmation"):
                score = 0.85
                warnings.append("subsegmental_candidate_score_capped_without_model_or_manual_support")

            if "_B8" in result.candidate_label:
                sibling_score = float(evidence.get("sibling_order_score") or 0.0)
                direction = float(evidence.get("direction_score") or 0.0)
                if sibling_score < 0.8 or direction < 0.75:
                    score = min(score, 0.75)
                    evidence["needs_review"] = True
                    warnings.append("B8_subsegment_conservative_score_cap")

        if evidence.get("coordinate_system_uncertain"):
            evidence["needs_review"] = True
            warnings.append("coordinate_system_uncertain_review_required")

        if score < AMBIGUOUS_SCORE_THRESHOLD:
            evidence["needs_review"] = True
            warnings.append("geometry_ambiguous_candidate_not_forced")

        score = round(max(0.0, min(0.98, score)), 4)
        constrained = replace(
            result,
            score=score,
            evidence=evidence,
            warnings=_dedupe(warnings),
            explanation=_append_score(result.explanation, score),
        )
        if evidence.get("needs_review"):
            _append_review_queue(mutable_hierarchy, constrained)
        out.append(constrained)

    return sorted(out, key=lambda item: (str(item.edge_id), -item.score, item.candidate_label))


def generate_candidates_for_network_curve(
    network_vtk: str | Path,
    hierarchy: Mapping[str, Any] | None,
    yaml_path: str | Path | None = None,
) -> list[CandidateResult]:
    """Apply the candidate engine to this repo's Slicer/VMTK network curve model."""

    from bronchoedu.airway_route import AirwayNetwork

    network = AirwayNetwork.from_network_vtk(network_vtk)
    rules = load_candidate_rules(yaml_path)
    engine = CandidateRuleEngine(rules)
    return engine.generate_candidates(network, hierarchy)


def candidate_results_payload(
    candidate_results: Sequence[CandidateResult],
    *,
    source: Mapping[str, Any] | None = None,
    max_per_edge: int | None = 4,
) -> dict[str, Any]:
    """Convert candidate results into a browser-friendly sidecar payload."""

    grouped: dict[str, list[dict[str, Any]]] = {}
    sorted_results = sorted(candidate_results, key=lambda item: (str(item.edge_id), -item.score, item.candidate_label))
    for result in sorted_results:
        key = str(result.edge_id)
        current = grouped.setdefault(key, [])
        if max_per_edge is not None and len(current) >= max_per_edge:
            continue
        current.append(_candidate_result_browser_dict(result))

    return {
        "schema": "airway_labeling_candidate_results/v1",
        "mode": "candidate_generation_not_final_labeling",
        "source": dict(source or {}),
        "edges": grouped,
    }


def write_candidate_results_json(
    path: str | Path,
    candidate_results: Sequence[CandidateResult],
    *,
    source: Mapping[str, Any] | None = None,
    max_per_edge: int | None = 4,
) -> dict[str, Any]:
    payload = candidate_results_payload(candidate_results, source=source, max_per_edge=max_per_edge)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(payload, indent=2, allow_nan=False), encoding="utf-8")
    return payload


def fuse_model_predictions(
    candidate_results: Sequence[CandidateResult],
    *,
    spgnn_predictions: Mapping[int | str, Mapping[str, Any]] | None = None,
    ipgn_predictions: Mapping[int | str, Mapping[str, Any]] | None = None,
    ptl_predictions: Mapping[int | str, Mapping[str, Any]] | None = None,
    hierarchy: Mapping[str, Any] | None = None,
) -> list[CandidateResult]:
    """Fuse optional SPGNN/PTL/IPGN predictions without forcing a final label."""

    fused: list[CandidateResult] = []
    for result in candidate_results:
        evidence = dict(result.evidence)
        warnings = list(result.warnings)
        score = float(result.score)
        edge_key = result.edge_id
        spgnn = _prediction_for(spgnn_predictions, edge_key)
        ipgn = _prediction_for(ipgn_predictions, edge_key)
        ptl = _prediction_for(ptl_predictions, edge_key)

        if result.candidate_level == "segmental" and spgnn:
            model_label = str(spgnn.get("label", ""))
            model_prob = float(spgnn.get("probability", spgnn.get("score", 0.0)) or 0.0)
            evidence["spgnn"] = dict(spgnn)
            if _same_label(model_label, result.candidate_label):
                score = min(0.98, max(score, model_prob) + 0.10)
                evidence["model_agreement"] = True
            elif _parent_lobe_conflict(model_label, result, hierarchy):
                score = min(score, 0.35)
                evidence["needs_review"] = True
                warnings.append("SPGNN_conflicts_with_parent_lobe_constraint")
            else:
                evidence["needs_review"] = True
                warnings.append("SPGNN_conflicts_with_book_candidate_but_may_be_sibling")

        if result.candidate_level in {"subsegmental", "sub_subsegmental"}:
            if score > 0.85 and not spgnn:
                score = 0.85
                warnings.append("subsegmental_fusion_score_capped_without_direct_model_support")

        agreement_count = 0
        for name, pred in (("ipgn", ipgn), ("ptl", ptl)):
            if not pred:
                continue
            evidence[name] = dict(pred)
            if _same_label(str(pred.get("label", "")), result.candidate_label):
                agreement_count += 1
        if agreement_count:
            score = min(0.98, score + 0.05 * agreement_count)
            evidence["graph_model_agreement_count"] = agreement_count

        if spgnn and ipgn and ptl:
            labels = {str(item.get("label", "")) for item in (spgnn, ipgn, ptl)}
            if result.candidate_label not in labels and len(labels) >= 3:
                score = min(score, 0.45)
                evidence["needs_review"] = True
                warnings.append("all_available_models_disagree_with_book_candidate")

        fused.append(replace(result, score=round(score, 4), evidence=evidence, warnings=_dedupe(warnings)))
    return sorted(fused, key=lambda item: (str(item.edge_id), -item.score, item.candidate_label))


class CandidateRuleEngine:
    def __init__(self, rules: Mapping[str, Any], *, coordinate_system: str = "RAS") -> None:
        self.rules = dict(rules)
        self.coordinate_system = coordinate_system
        self.scoring = dict(self.rules.get("candidate_scoring") or {})

    def generate_candidates(
        self,
        graph: Any,
        hierarchy: Mapping[str, Any] | None,
        *,
        levels: Sequence[str] = ("segmental", "subsegmental"),
    ) -> list[CandidateResult]:
        results: list[CandidateResult] = []
        if "segmental" in levels:
            results.extend(self.generate_segmental_candidates(graph, hierarchy))
        if "subsegmental" in levels:
            results.extend(self.generate_subsegmental_candidates(graph, hierarchy))
        return sorted(results, key=lambda item: (str(item.edge_id), -item.score, item.candidate_label))

    def generate_segmental_candidates(self, graph: Any, hierarchy: Mapping[str, Any] | None) -> list[CandidateResult]:
        hierarchy_map = _hierarchy(hierarchy)
        raw_results: list[CandidateResult] = []
        for edge in _iter_edges(graph):
            parent_context = _parent_context_for_edge(graph, edge, hierarchy_map)
            if parent_context is None:
                continue
            section = self._match_section(parent_context["label"])
            if section is None:
                continue
            lung_key, section_key, section_payload = section
            side = "right" if lung_key == "right_lung" else "left"
            siblings = _sibling_edges(graph, edge)
            parent_edge = _parent_edge_for_edge(graph, edge)
            bstar_like = _is_bstar_like(edge, hierarchy_map)
            optional_variants = dict(section_payload.get("optional_variant_branches") or {})
            normal_candidates = dict(section_payload.get("segmental_candidates") or {})

            if bstar_like and optional_variants and not bool(hierarchy_map.get("allow_bstar_as_basal_child")):
                for rule_key, payload in optional_variants.items():
                    raw_results.append(
                        self._score_rule(
                            edge=edge,
                            graph=graph,
                            hierarchy=hierarchy_map,
                            rule=self._candidate_rule(
                                label=str(payload.get("label", rule_key)),
                                level="variant",
                                side=side,
                                section=section_key,
                                parent_context_labels=self._section_context_labels(section_key, section_payload),
                                payload=payload,
                                expected_key="expected_location",
                                metadata_extra={"rule_key": rule_key, "variant": True, "bstar_variant": True},
                            ),
                            parent_context=parent_context,
                            siblings=siblings,
                            parent_edge=parent_edge,
                        )
                    )
                continue

            for label, payload in normal_candidates.items():
                if label == "LLL_B7_8" and not bool(hierarchy_map.get("allow_left_b7_8_combined_candidate")):
                    continue
                raw_results.append(
                    self._score_rule(
                        edge=edge,
                        graph=graph,
                        hierarchy=hierarchy_map,
                        rule=self._candidate_rule(
                            label=str(label),
                            level="segmental",
                            side=side,
                            section=section_key,
                            parent_context_labels=self._section_context_labels(section_key, section_payload),
                            payload=payload,
                            expected_key="expected_direction",
                        ),
                        parent_context=parent_context,
                        siblings=siblings,
                        parent_edge=parent_edge,
                    )
                )

            if bstar_like and optional_variants:
                for rule_key, payload in optional_variants.items():
                    raw_results.append(
                        self._score_rule(
                            edge=edge,
                            graph=graph,
                            hierarchy=hierarchy_map,
                            rule=self._candidate_rule(
                                label=str(payload.get("label", rule_key)),
                                level="variant",
                                side=side,
                                section=section_key,
                                parent_context_labels=self._section_context_labels(section_key, section_payload),
                                payload=payload,
                                expected_key="expected_location",
                                metadata_extra={"rule_key": rule_key, "variant": True, "bstar_variant": True},
                            ),
                            parent_context=parent_context,
                            siblings=siblings,
                            parent_edge=parent_edge,
                        )
                    )
        return apply_hierarchy_constraints(raw_results, hierarchy)

    def generate_subsegmental_candidates(self, graph: Any, hierarchy: Mapping[str, Any] | None) -> list[CandidateResult]:
        hierarchy_map = _hierarchy(hierarchy)
        raw_results: list[CandidateResult] = []
        for edge in _iter_edges(graph):
            parent_context = _parent_context_for_edge(graph, edge, hierarchy_map)
            if parent_context is None:
                continue
            parent_rule = self._match_segmental_candidate(parent_context["label"])
            if parent_rule is None:
                continue
            lung_key, section_key, segmental_label, segmental_payload = parent_rule
            side = "right" if lung_key == "right_lung" else "left"
            children = dict(segmental_payload.get("children") or {})
            if not children:
                continue
            siblings = _sibling_edges(graph, edge)
            parent_edge = _parent_edge_for_edge(graph, edge)
            for label, payload in children.items():
                raw_results.append(
                    self._score_rule(
                        edge=edge,
                        graph=graph,
                        hierarchy=hierarchy_map,
                        rule=self._candidate_rule(
                            label=str(label),
                            level="subsegmental",
                            side=side,
                            section=section_key,
                            parent_context_labels=[segmental_label],
                            payload=payload,
                            expected_key="expected_direction",
                            metadata_extra={"segmental_parent": segmental_label},
                        ),
                        parent_context=parent_context,
                        siblings=siblings,
                        parent_edge=parent_edge,
                    )
                )
        return apply_hierarchy_constraints(raw_results, hierarchy)

    def _score_rule(
        self,
        *,
        edge: Any,
        graph: Any,
        hierarchy: Mapping[str, Any],
        rule: CandidateRule,
        parent_context: Mapping[str, Any],
        siblings: Sequence[Any],
        parent_edge: Any | None,
    ) -> CandidateResult:
        edge_id = _edge_id(edge)
        coordinate_system = str(hierarchy.get("coordinate_system") or self.coordinate_system or "UNKNOWN")
        coordinate_system_uncertain = coordinate_system.upper() not in {"RAS", "LPS"}
        vector = _oriented_edge_vector(graph, edge)
        direction_score_value = score_direction(vector, rule.expected_direction_terms, rule.lung_side, coordinate_system)
        direction = DirectionEvidence(
            edge_vector=_round_list(vector, 5),
            coordinate_system=coordinate_system,
            side=rule.lung_side,
            anatomical_components=_anatomical_components(vector, side=rule.lung_side, coordinate_system=coordinate_system),
            expected_terms=list(rule.expected_direction_terms),
            score=direction_score_value,
            warnings=["coordinate_system_uncertain"] if coordinate_system_uncertain else [],
        )

        sibling_score = score_sibling_order(edge, siblings, rule.sibling_context)
        generation_score = _generation_score(edge, hierarchy, rule.candidate_level)
        length_score = _length_score(edge, siblings)
        radius_score = _radius_score(edge, siblings)
        angle_score = _branch_angle_score(vector, _edge_vector(parent_edge) if parent_edge is not None else None)
        proximity_score = _proximity_score(graph, edge, hierarchy, rule.expected_direction_terms)

        parent_context_bonus = float(self.scoring.get("parent_context_bonus", 0.20))
        base = float(self.scoring.get("base_score", 0.30))
        score = base + parent_context_bonus
        score += float(self.scoring.get("direction_match_bonus", 0.20)) * direction_score_value
        score += 0.15 * sibling_score
        score += 0.05 * generation_score
        score += 0.04 * length_score
        score += 0.03 * radius_score
        score += 0.03 * angle_score
        score += 0.05 * proximity_score

        warnings: list[str] = []
        if len(siblings) <= 1:
            score += float(self.scoring.get("missing_sibling_penalty", -0.10))
            warnings.append("missing_sibling_context")
        if rule.metadata.get("variant"):
            score += float(self.scoring.get("variant_penalty", -0.10))
            warnings.append("variant_candidate_only")
        if coordinate_system_uncertain:
            score += float(self.scoring.get("coordinate_uncertainty_penalty", -0.20))
            warnings.append("coordinate_system_uncertain")

        score = round(max(0.0, min(0.98, score)), 4)
        evidence = {
            "parent_label": parent_context.get("label"),
            "parent_context_source": parent_context.get("source"),
            "parent_confidence": parent_context.get("confidence", 1.0),
            "parent_locked": bool(parent_context.get("locked", False)),
            "direction_evidence": asdict(direction),
            "direction_score": direction_score_value,
            "sibling_order_score": sibling_score,
            "generation_score": generation_score,
            "branch_length_score": length_score,
            "radius_score": radius_score,
            "branch_angle_score": angle_score,
            "proximity_score": proximity_score,
            "sibling_edge_ids": [_edge_id(item) for item in siblings],
            "coordinate_system_uncertain": coordinate_system_uncertain,
            "rule_section": rule.section,
            "rule_metadata": rule.metadata,
        }
        if rule.metadata.get("bstar_variant"):
            evidence["bstar_variant"] = True
            evidence["do_not_treat_as_normal_basal_child"] = True

        explanation = (
            f"{rule.label} candidate for edge {edge_id}: parent context {parent_context.get('label')}; "
            f"direction {direction_score_value:.2f} for {', '.join(rule.expected_direction_terms) or 'no expected terms'}; "
            f"sibling order {sibling_score:.2f}; generation/length/radius/angle/proximity "
            f"{generation_score:.2f}/{length_score:.2f}/{radius_score:.2f}/{angle_score:.2f}/{proximity_score:.2f}."
        )
        return CandidateResult(
            edge_id=edge_id,
            candidate_label=rule.label,
            candidate_level=rule.candidate_level,
            score=score,
            evidence=evidence,
            explanation=explanation,
            warnings=_dedupe(warnings + direction.warnings),
        )

    def _candidate_rule(
        self,
        *,
        label: str,
        level: str,
        side: str,
        section: str,
        parent_context_labels: list[str],
        payload: Mapping[str, Any],
        expected_key: str,
        metadata_extra: Mapping[str, Any] | None = None,
    ) -> CandidateRule:
        metadata = {key: value for key, value in payload.items() if key not in {"expected_direction", "expected_location", "sibling_context"}}
        metadata.update(metadata_extra or {})
        return CandidateRule(
            label=label,
            candidate_level=level,
            lung_side=side,
            section=section,
            parent_context_labels=parent_context_labels,
            expected_direction_terms=[str(item) for item in payload.get(expected_key, []) or []],
            sibling_context=[str(item) for item in payload.get("sibling_context", []) or []],
            metadata=metadata,
        )

    def _match_section(self, parent_label: str) -> tuple[str, str, Mapping[str, Any]] | None:
        parent_norm = _norm_label(parent_label)
        for lung_key in ("right_lung", "left_lung"):
            lung = self.rules.get(lung_key) or {}
            if not isinstance(lung, Mapping):
                continue
            for section_key, section_payload in lung.items():
                if not isinstance(section_payload, Mapping):
                    continue
                accepted = self._section_context_labels(str(section_key), section_payload)
                if parent_norm in {_norm_label(item) for item in accepted}:
                    return lung_key, str(section_key), section_payload
        return None

    def _match_segmental_candidate(self, parent_label: str) -> tuple[str, str, str, Mapping[str, Any]] | None:
        parent_norm = _norm_label(parent_label)
        for lung_key in ("right_lung", "left_lung"):
            lung = self.rules.get(lung_key) or {}
            if not isinstance(lung, Mapping):
                continue
            for section_key, section_payload in lung.items():
                if not isinstance(section_payload, Mapping):
                    continue
                for label, payload in dict(section_payload.get("segmental_candidates") or {}).items():
                    if parent_norm == _norm_label(str(label)):
                        return lung_key, str(section_key), str(label), payload
        return None

    @staticmethod
    def _section_context_labels(section_key: str, section_payload: Mapping[str, Any]) -> list[str]:
        labels = [section_key]
        parent = section_payload.get("parent")
        if parent:
            labels.append(str(parent))
        aliases = {
            "RUL": ["right upper lobe", "right upper lobe bronchus"],
            "RML": ["right middle lobe", "right middle lobe bronchus"],
            "RLL_SUPERIOR": ["right B6 parent", "right lower lobe superior segment"],
            "RLL_BASAL": ["right basal", "right truncus basalis"],
            "LUL_SUPERIOR": ["left superior segment", "left upper lobe superior division"],
            "LINGULA": ["left lingula", "left lingular segment bronchus"],
            "LLL_SUPERIOR": ["left B6 parent", "left lower lobe superior segment"],
            "LLL_BASAL": ["left basal", "left truncus basalis"],
        }
        labels.extend(aliases.get(section_key, []))
        return _dedupe(labels)


def _prediction_for(predictions: Mapping[int | str, Mapping[str, Any]] | None, edge_id: int | str) -> Mapping[str, Any] | None:
    if not predictions:
        return None
    return predictions.get(edge_id) or predictions.get(str(edge_id))


def _parent_lobe_conflict(model_label: str, result: CandidateResult, hierarchy: Mapping[str, Any] | None) -> bool:
    del hierarchy
    model_prefix = model_label.split("_", 1)[0]
    candidate_prefix = result.candidate_label.split("_", 1)[0]
    return bool(model_prefix and candidate_prefix and model_prefix != candidate_prefix)


def _same_label(a: str, b: str) -> bool:
    return _norm_label(a) == _norm_label(b)


def _hierarchy(hierarchy: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return hierarchy or {}


def _iter_edges(graph: Any) -> list[Any]:
    edges = _get(graph, "edges", None)
    if edges is None and isinstance(graph, Mapping):
        edges = graph.get("edges")
    if callable(edges):
        edges = edges()
    if edges is None:
        return []
    if isinstance(edges, Mapping):
        return list(edges.values())
    return list(edges)


def _edge_by_id(graph: Any) -> dict[int | str, Any]:
    return {_edge_id(edge): edge for edge in _iter_edges(graph)}


def _node_by_id(graph: Any, node_id: int | str) -> Any | None:
    nodes = _get(graph, "nodes", None)
    if nodes is None and isinstance(graph, Mapping):
        nodes = graph.get("nodes")
    if nodes is None:
        return None
    if isinstance(nodes, Mapping):
        return nodes.get(node_id) or nodes.get(str(node_id))
    try:
        return list(nodes)[int(node_id)]
    except (ValueError, TypeError, IndexError):
        for node in nodes:
            if _get(node, "id", None) == node_id or str(_get(node, "id", "")) == str(node_id):
                return node
    return None


def _node_point(graph: Any, node_id: int | str) -> list[float] | None:
    node = _node_by_id(graph, node_id)
    if node is None:
        return None
    point = _get(node, "ras", None)
    if point is None:
        point = _get(node, "point", None)
    if point is None:
        point = _get(node, "position", None)
    return _vector_list(point) if point is not None else None


def _root_distances(graph: Any) -> Sequence[float] | Mapping[int | str, float] | None:
    distances = _get(graph, "root_distances", None)
    if distances is None and isinstance(graph, Mapping):
        distances = graph.get("root_distances")
    return distances


def _distance_for_node(distances: Sequence[float] | Mapping[int | str, float] | None, node_id: int | str) -> float | None:
    if distances is None:
        return None
    if isinstance(distances, Mapping):
        value = distances.get(node_id, distances.get(str(node_id)))
    else:
        try:
            value = distances[int(node_id)]
        except (ValueError, TypeError, IndexError):
            return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _proximal_node_id(graph: Any, edge: Any) -> int | str | None:
    start = _get(edge, "start_node", _get(edge, "startNode", None))
    end = _get(edge, "end_node", _get(edge, "endNode", None))
    if start is None or end is None:
        return _get(edge, "proximal_node", _get(edge, "source", None))
    distances = _root_distances(graph)
    start_distance = _distance_for_node(distances, start)
    end_distance = _distance_for_node(distances, end)
    if start_distance is not None and end_distance is not None and end_distance < start_distance:
        return end
    return start


def _distal_node_id(graph: Any, edge: Any) -> int | str | None:
    start = _get(edge, "start_node", _get(edge, "startNode", None))
    end = _get(edge, "end_node", _get(edge, "endNode", None))
    if start is None or end is None:
        return _get(edge, "distal_node", _get(edge, "target", None))
    proximal = _proximal_node_id(graph, edge)
    return end if proximal == start else start


def _sibling_edges(graph: Any, edge: Any) -> list[Any]:
    explicit = _get(edge, "sibling_edges", None)
    if explicit is not None:
        return list(explicit)
    hierarchy_siblings = _get(graph, "siblings_by_edge", None)
    if isinstance(hierarchy_siblings, Mapping):
        sibling_ids = hierarchy_siblings.get(_edge_id(edge), hierarchy_siblings.get(str(_edge_id(edge)), []))
        by_id = _edge_by_id(graph)
        return [by_id[item] for item in sibling_ids if item in by_id]

    proximal = _proximal_node_id(graph, edge)
    if proximal is None:
        return [edge]
    adj = _get(graph, "adj", None)
    if adj is None and isinstance(graph, Mapping):
        adj = graph.get("adj")
    if not isinstance(adj, Mapping):
        return [edge]

    by_id = _edge_by_id(graph)
    distances = _root_distances(graph)
    proximal_distance = _distance_for_node(distances, proximal)
    siblings: list[Any] = []
    for item in adj.get(proximal, adj.get(str(proximal), [])):
        if isinstance(item, Mapping):
            neighbor = item.get("neighbor", item.get("node"))
            edge_id = item.get("edge_id", item.get("edgeId"))
        else:
            neighbor, edge_id = item
        if edge_id not in by_id:
            continue
        if proximal_distance is not None:
            neighbor_distance = _distance_for_node(distances, neighbor)
            if neighbor_distance is not None and neighbor_distance <= proximal_distance + 1e-6:
                continue
        siblings.append(by_id[edge_id])
    return siblings or [edge]


def _parent_edge_for_edge(graph: Any, edge: Any) -> Any | None:
    explicit = _get(edge, "parent_edge", None)
    if explicit is not None:
        return explicit
    proximal = _proximal_node_id(graph, edge)
    if proximal is None:
        return None
    adj = _get(graph, "adj", None)
    if adj is None and isinstance(graph, Mapping):
        adj = graph.get("adj")
    if not isinstance(adj, Mapping):
        return None
    distances = _root_distances(graph)
    proximal_distance = _distance_for_node(distances, proximal)
    if proximal_distance is None:
        return None
    by_id = _edge_by_id(graph)
    for item in adj.get(proximal, adj.get(str(proximal), [])):
        if isinstance(item, Mapping):
            neighbor = item.get("neighbor", item.get("node"))
            edge_id = item.get("edge_id", item.get("edgeId"))
        else:
            neighbor, edge_id = item
        neighbor_distance = _distance_for_node(distances, neighbor)
        if neighbor_distance is not None and neighbor_distance < proximal_distance - 1e-6:
            return by_id.get(edge_id)
    return None


def _parent_context_for_edge(graph: Any, edge: Any, hierarchy: Mapping[str, Any]) -> dict[str, Any] | None:
    edge_id = _edge_id(edge)
    parent_label = _lookup_label_info(hierarchy.get("parent_labels_by_edge"), edge_id)
    if parent_label:
        return {**parent_label, "source": "parent_labels_by_edge"}
    edge_parent_label = _get(edge, "parent_label", None)
    if edge_parent_label:
        return {"label": str(edge_parent_label), "confidence": 1.0, "locked": True, "source": "edge.parent_label"}

    proximal = _proximal_node_id(graph, edge)
    if proximal is not None:
        node_label = _lookup_label_info(hierarchy.get("node_labels"), proximal)
        if node_label:
            return {**node_label, "source": "node_labels"}
        node_payload = _lookup_label_info(hierarchy.get("nodes"), proximal)
        if node_payload:
            return {**node_payload, "source": "nodes"}

    parent_edge = _parent_edge_for_edge(graph, edge)
    if parent_edge is not None:
        parent_edge_label = _lookup_label_info(hierarchy.get("edge_labels"), _edge_id(parent_edge))
        if parent_edge_label:
            return {**parent_edge_label, "source": "edge_labels"}
        label_from_edge = _edge_label_from_any(parent_edge)
        if label_from_edge:
            return {"label": label_from_edge, "confidence": 1.0, "locked": True, "source": "parent_edge.label"}
    return None


def _lookup_label_info(container: Any, key: int | str) -> dict[str, Any] | None:
    if not isinstance(container, Mapping):
        return None
    value = container.get(key, container.get(str(key)))
    if value is None:
        return None
    if isinstance(value, str):
        return {"label": value, "confidence": 1.0, "locked": True}
    if isinstance(value, Mapping):
        label = value.get("label") or value.get("candidate_label") or value.get("anatomical_label") or value.get("name")
        if not label:
            return None
        return {
            "label": str(label),
            "confidence": float(value.get("confidence", value.get("score", 1.0)) or 0.0),
            "locked": bool(value.get("locked", False)),
        }
    return None


def _edge_label_from_any(edge: Any) -> str | None:
    if edge is None:
        return None
    value = _get(edge, "label", None) or _get(edge, "candidate_label", None) or _get(edge, "anatomical_label", None)
    return str(value) if value else None


def _edge_id(edge: Any) -> int | str:
    value = _get(edge, "id", _get(edge, "edge_id", _get(edge, "edgeId", None)))
    if value is None:
        value = _get(edge, "cell_id", _get(edge, "cellId", "unknown"))
    return value


def _oriented_edge_vector(graph: Any, edge: Any) -> list[float]:
    explicit = _get(edge, "vector", None)
    if explicit is None:
        explicit = _get(edge, "edge_vector", None)
    if explicit is None:
        explicit = _get(edge, "first_direction_ras", None)
    if explicit is not None:
        return _vector_list(explicit)

    points = _edge_points(edge)
    if points and len(points) >= 2:
        proximal = _proximal_node_id(graph, edge)
        start = _get(edge, "start_node", _get(edge, "startNode", None))
        if proximal is not None and start is not None and proximal != start:
            return _subtract(points[0], points[-1])
        return _subtract(points[-1], points[0])

    proximal = _proximal_node_id(graph, edge)
    distal = _distal_node_id(graph, edge)
    if proximal is not None and distal is not None:
        start_point = _node_point(graph, proximal)
        end_point = _node_point(graph, distal)
        if start_point is not None and end_point is not None:
            return _subtract(end_point, start_point)
    return [0.0, 0.0, 0.0]


def _edge_vector(edge: Any | None) -> list[float]:
    if edge is None:
        return [0.0, 0.0, 0.0]
    explicit = _get(edge, "vector", None)
    if explicit is None:
        explicit = _get(edge, "edge_vector", None)
    if explicit is None:
        explicit = _get(edge, "first_direction_ras", None)
    if explicit is not None:
        return _vector_list(explicit)
    points = _edge_points(edge)
    if points and len(points) >= 2:
        return _subtract(points[-1], points[0])
    return [0.0, 0.0, 0.0]


def _edge_points(edge: Any) -> list[list[float]] | None:
    points = _get(edge, "points_ras", None)
    if points is None:
        points = _get(edge, "pointsRas", None)
    if points is None:
        points = _get(edge, "points", None)
    if points is None:
        return None
    return [_vector_list(point) for point in points]


def _edge_length(edge: Any) -> float:
    value = _get(edge, "length_mm", _get(edge, "lengthMm", None))
    if value is not None:
        return _safe_float(value)
    points = _edge_points(edge)
    if not points or len(points) < 2:
        return float("nan")
    return sum(_norm(_subtract(points[i + 1], points[i])) for i in range(len(points) - 1))


def _edge_radius(edge: Any) -> float:
    value = _get(edge, "mean_radius_mm", _get(edge, "meanRadiusMm", None))
    if value is not None:
        return _safe_float(value)
    values = _get(edge, "radius_mm", _get(edge, "radiusMm", None))
    if values is None:
        return float("nan")
    finite = [_safe_float(value) for value in values]
    finite = [value for value in finite if math.isfinite(value)]
    return sum(finite) / len(finite) if finite else float("nan")


def _generation_score(edge: Any, hierarchy: Mapping[str, Any], candidate_level: str) -> float:
    generation = _get(edge, "generation", None)
    if generation is None and isinstance(hierarchy.get("edge_generations"), Mapping):
        generation = hierarchy["edge_generations"].get(_edge_id(edge), hierarchy["edge_generations"].get(str(_edge_id(edge))))
    if generation is None:
        return 0.5
    expected = {"segmental": 3, "subsegmental": 4, "sub_subsegmental": 5}.get(candidate_level)
    if expected is None:
        return 0.8
    diff = abs(float(generation) - float(expected))
    if diff < 0.25:
        return 1.0
    if diff <= 1.0:
        return 0.5
    return 0.2


def _length_score(edge: Any, siblings: Sequence[Any]) -> float:
    length = _edge_length(edge)
    sibling_lengths = [_edge_length(item) for item in siblings if math.isfinite(_edge_length(item)) and _edge_length(item) > 0]
    if not math.isfinite(length) or not sibling_lengths:
        return 0.5
    med = median(sibling_lengths)
    if med <= 0:
        return 0.5
    return round(max(0.0, min(1.0, length / med)), 4)


def _radius_score(edge: Any, siblings: Sequence[Any]) -> float:
    radius = _edge_radius(edge)
    sibling_radii = [_edge_radius(item) for item in siblings if math.isfinite(_edge_radius(item)) and _edge_radius(item) > 0]
    if not math.isfinite(radius) or not sibling_radii:
        return 0.5
    largest = max(sibling_radii)
    return round(max(0.0, min(1.0, radius / largest)), 4)


def _branch_angle_score(edge_vector: Sequence[float], parent_vector: Sequence[float] | None) -> float:
    if parent_vector is None:
        return 0.5
    angle = _angle_degrees(parent_vector, edge_vector)
    if not math.isfinite(angle):
        return 0.5
    return round(max(0.0, min(1.0, 1.0 - min(angle, 120.0) / 120.0)), 4)


def _proximity_score(graph: Any, edge: Any, hierarchy: Mapping[str, Any], expected_terms: Sequence[str]) -> float:
    proximity_terms = [_normalize_direction_term(term) for term in expected_terms if str(term).startswith(("close_to_", "far_from_"))]
    if not proximity_terms:
        return 0.5
    centers = _known_edge_centers_by_label(graph, hierarchy)
    edge_center = _edge_center(edge)
    if edge_center is None:
        return 0.5
    scores: list[float] = []
    for term in proximity_terms:
        close = term.startswith("close_to_")
        if term.startswith("close_to_"):
            label_suffix = term.removeprefix("close_to_")
        else:
            label_suffix = term.removeprefix("far_from_")
        known = [center for label, center in centers.items() if _norm_label(label).endswith(_norm_label(label_suffix))]
        if not known:
            scores.append(0.5)
            continue
        distance = min(_norm(_subtract(edge_center, center)) for center in known)
        closeness = max(0.0, min(1.0, 1.0 - distance / 80.0))
        scores.append(closeness if close else 1.0 - closeness)
    return round(sum(scores) / len(scores), 4)


def _known_edge_centers_by_label(graph: Any, hierarchy: Mapping[str, Any]) -> dict[str, list[float]]:
    by_id = _edge_by_id(graph)
    out: dict[str, list[float]] = {}
    labels = hierarchy.get("edge_labels")
    if not isinstance(labels, Mapping):
        return out
    for edge_id, payload in labels.items():
        info = _lookup_label_info(labels, edge_id)
        edge = by_id.get(edge_id, by_id.get(str(edge_id)))
        center = _edge_center(edge) if edge is not None else None
        if info and center is not None:
            out[info["label"]] = center
    return out


def _edge_center(edge: Any) -> list[float] | None:
    points = _edge_points(edge)
    if points:
        n = len(points)
        return [sum(point[i] for point in points) / n for i in range(3)]
    vector = _edge_vector(edge)
    if _norm(vector) > 0:
        return [value / 2.0 for value in vector]
    return None


def _is_bstar_like(edge: Any, hierarchy: Mapping[str, Any]) -> bool:
    edge_id = _edge_id(edge)
    value = _get(edge, "between_b6_and_basal", None)
    if value is None:
        value = _get(edge, "bstar_candidate", None)
    attrs = hierarchy.get("edge_attributes")
    if value is None and isinstance(attrs, Mapping):
        edge_attrs = attrs.get(edge_id, attrs.get(str(edge_id), {}))
        if isinstance(edge_attrs, Mapping):
            value = edge_attrs.get("between_b6_and_basal", edge_attrs.get("bstar_candidate"))
    return bool(value)


def _anatomical_components(
    edge_vector: Sequence[float] | Mapping[str, float],
    *,
    side: str,
    coordinate_system: str,
) -> dict[str, float]:
    if isinstance(edge_vector, Mapping) and any(key in edge_vector for key in ("cranial", "caudal", "dorsal", "ventral", "lateral", "medial")):
        out = {key: max(0.0, float(edge_vector.get(key, 0.0))) for key in ("cranial", "caudal", "dorsal", "ventral", "lateral", "medial")}
        out["horizontal"] = max(0.0, float(edge_vector.get("horizontal", 0.0)))
        out["vertical"] = max(0.0, float(edge_vector.get("vertical", 0.0)))
        return out

    coordinate = coordinate_system.upper()
    if coordinate not in {"RAS", "LPS"}:
        return {}
    x, y, z = _unit_vector(_vector_list(edge_vector))
    side_value = side.lower()

    cranial = max(z, 0.0)
    caudal = max(-z, 0.0)
    if coordinate == "RAS":
        ventral = max(y, 0.0)
        dorsal = max(-y, 0.0)
        if side_value == "right":
            lateral = max(x, 0.0)
            medial = max(-x, 0.0)
        else:
            lateral = max(-x, 0.0)
            medial = max(x, 0.0)
    else:
        ventral = max(-y, 0.0)
        dorsal = max(y, 0.0)
        if side_value == "right":
            lateral = max(-x, 0.0)
            medial = max(x, 0.0)
        else:
            lateral = max(x, 0.0)
            medial = max(-x, 0.0)

    return {
        "cranial": round(cranial, 6),
        "caudal": round(caudal, 6),
        "dorsal": round(dorsal, 6),
        "ventral": round(ventral, 6),
        "lateral": round(lateral, 6),
        "medial": round(medial, 6),
        "horizontal": round(math.sqrt(max(0.0, x * x + y * y)), 6),
        "vertical": round(abs(z), 6),
    }


def _normalize_direction_term(term: Any) -> str:
    out = str(term).strip().lower()
    out = out.replace("+", "_plus_").replace("/", "_or_").replace("-", "_")
    for suffix in ("_subbranch", "_segments"):
        out = out.replace(suffix, "")
    return out


def _is_non_direction_term(term: str) -> bool:
    return term.startswith(("close_to_", "far_from_", "between_"))


def _relative_rank_score(value: float, sibling_values: Sequence[float]) -> float:
    if not sibling_values:
        return 0.0
    better = sum(1 for item in sibling_values if value > item + 1e-6)
    tied = sum(1 for item in sibling_values if abs(value - item) <= 1e-6)
    return (better + 0.5 * tied) / len(sibling_values)


def _vector_list(values: Any) -> list[float]:
    if isinstance(values, Mapping):
        values = [values.get("x", 0.0), values.get("y", 0.0), values.get("z", 0.0)]
    return [float(item) for item in list(values)[:3]]


def _subtract(a: Sequence[float], b: Sequence[float]) -> list[float]:
    return [float(a[i]) - float(b[i]) for i in range(3)]


def _norm(v: Sequence[float]) -> float:
    return math.sqrt(sum(float(item) * float(item) for item in v))


def _unit_vector(v: Sequence[float]) -> list[float]:
    n = _norm(v)
    if n < 1e-12:
        return [0.0, 0.0, 0.0]
    return [float(item) / n for item in v]


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    au = _unit_vector(a)
    bu = _unit_vector(b)
    return sum(au[i] * bu[i] for i in range(3))


def _angle_degrees(a: Sequence[float], b: Sequence[float]) -> float:
    if _norm(a) < 1e-12 or _norm(b) < 1e-12:
        return float("nan")
    return math.degrees(math.acos(max(-1.0, min(1.0, _cosine(a, b)))))


def _round_list(values: Sequence[float], ndigits: int = 4) -> list[float]:
    return [round(float(value), ndigits) for value in values]


def _safe_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _norm_label(label: Any) -> str:
    return "".join(ch for ch in str(label).lower() if ch.isalnum())


def _dedupe(values: Iterable[Any]) -> list[Any]:
    out: list[Any] = []
    seen: set[str] = set()
    for value in values:
        key = json.dumps(value, sort_keys=True, default=str)
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _append_score(explanation: str, score: float) -> str:
    prefix = explanation.rsplit(" Final candidate score:", 1)[0]
    return f"{prefix} Final candidate score: {score:.2f}."


def _append_review_queue(hierarchy: dict[str, Any] | None, result: CandidateResult) -> None:
    if hierarchy is None:
        return
    queue = hierarchy.setdefault("review_queue", [])
    if not isinstance(queue, list):
        return
    queue.append(
        {
            "edge_id": result.edge_id,
            "candidate_label": result.candidate_label,
            "score": result.score,
            "warnings": list(result.warnings),
        }
    )


def _candidate_result_browser_dict(result: CandidateResult) -> dict[str, Any]:
    return {
        "edgeId": result.edge_id,
        "candidateLabel": result.candidate_label,
        "candidateLevel": result.candidate_level,
        "score": result.score,
        "evidence": result.evidence,
        "explanation": result.explanation,
        "warnings": result.warnings,
        "source": result.source,
    }
