from app import label


def test_label_trims_and_capitalizes():
    assert label(" hello ") == "Hello"


def test_blank_is_empty():
    assert label("   ") == "empty"
