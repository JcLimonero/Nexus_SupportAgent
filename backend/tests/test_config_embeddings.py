"""EMBEDDING_PROVIDER / EMBEDDING_DIMENSIONS cross-check (audit Phase C, finding 6)."""
import pytest
from pydantic import ValidationError

from config import Settings


def test_local_default_ok():
    assert Settings(embedding_provider="local", embedding_dimensions=384).embedding_dimensions == 384


def test_vertexai_requires_768():
    assert Settings(embedding_provider="vertexai", embedding_dimensions=768).embedding_dimensions == 768


def test_vertexai_with_local_dims_rejected():
    # The exact silent-misconfig the guard exists for: 768-D embeddings written
    # into a Vector(384) column.
    with pytest.raises(ValidationError):
        Settings(embedding_provider="vertexai", embedding_dimensions=384)


def test_local_with_vertex_dims_rejected():
    with pytest.raises(ValidationError):
        Settings(embedding_provider="local", embedding_dimensions=768)
