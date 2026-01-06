# Poseidon2 bindings for js

Poseidon2, unlike keccak, can differ based on various params. In order to ensure we have an exact match with the logic in a noir cirucit, we can simply use another noir circuit to compute and output the hash. While this is likely less efficient than a native impl, it is functional and requires no searching/trying different js libs to find a match.
