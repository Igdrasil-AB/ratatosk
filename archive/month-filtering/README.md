# Archived month filtering

This directory preserves the removed month-bounded collection implementation
and its tests for reference. It is not part of the build or test suite.

Ratatosk now always enumerates all available invoice history and relies on its
accepted-document identity store to skip duplicates. Reintroducing date bounds
requires a new product decision and fresh end-to-end evidence; do not reconnect
these files to the live collector implicitly.
