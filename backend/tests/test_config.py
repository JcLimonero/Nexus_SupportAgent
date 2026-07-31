"""Prod-detection + insecure-secret guard (audit Phase A, finding 1)."""
import pytest
from pydantic import ValidationError

from config import Settings


def test_environment_production_is_prod():
    s = Settings(environment="production", local_jwt_secret="a-strong-random-value-1234567890")
    assert s.is_production is True


def test_gcs_bucket_still_counts_as_prod():
    s = Settings(gcs_bucket_name="some-bucket", local_jwt_secret="a-strong-random-value-1234567890")
    assert s.is_production is True


def test_default_is_dev():
    assert Settings().is_production is False


def test_prod_rejects_insecure_secret():
    # The whole point: a default secret must fail loudly on the on-prem VPS,
    # where there is no GCS bucket to infer prod from.
    with pytest.raises(ValidationError):
        Settings(environment="production", local_jwt_secret="local-dev-secret-change-in-production")


def test_dev_allows_insecure_secret():
    # Dev must stay frictionless — the default secret is fine locally.
    assert Settings(environment="dev").is_production is False
