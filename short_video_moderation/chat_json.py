"""Parse structured responses from the independent multimodal baseline."""
import json
from typing import Any, Mapping

def _strip_json_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        first_newline = stripped.find("\n")
        if first_newline >= 0:
            stripped = stripped[first_newline + 1 :]
        if stripped.endswith("```"):
            stripped = stripped[:-3]
    return stripped.strip()


def parse_chat_completion_json(response: Mapping[str, Any]) -> dict[str, Any]:
    try:
        content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("LLM response does not contain message content") from exc
    if isinstance(content, list):
        text = "".join(
            str(item.get("text", ""))
            for item in content
            if isinstance(item, Mapping)
        )
    else:
        text = str(content)
    try:
        parsed = json.loads(_strip_json_fence(text))
    except json.JSONDecodeError as exc:
        decoder = json.JSONDecoder()
        parsed = None
        for index, character in enumerate(text):
            if character != "{":
                continue
            try:
                candidate, _ = decoder.raw_decode(text[index:])
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict):
                parsed = candidate
                break
        if parsed is None:
            raise ValueError(f"LLM did not return valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("LLM evaluation must be a JSON object")
    return parsed


