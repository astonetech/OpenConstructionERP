# PyInstaller hook for pixeltable-pgserver.
#
# The desktop sidecar runs the whole app on an embedded PostgreSQL 16 cluster
# booted from this package's bundled binaries. The binaries live in a
# ``pginstall/`` directory next to the Python module (``bin/`` holds
# postgres, initdb, pg_ctl, ...; ``lib/`` and ``share/`` hold the runtime
# support files). PyInstaller does not see these because they are plain data
# next to the package rather than imported modules, so without this hook the
# frozen sidecar starts, tries to spawn postgres, and dies with "postgres
# executable not found". Collecting the full package data tree fixes that.
#
# We deliberately collect data files (not collect_dynamic_libs): the postgres
# binaries and their .so/.dll/.dylib support files must keep the exact
# ``pginstall/...`` relative layout pg_ctl expects, and collect_data_files
# preserves that tree verbatim. The pginstall payload is ~40 MB; that is the
# price of a Docker-free, zero-setup PostgreSQL on the user's machine.

from PyInstaller.utils.hooks import collect_data_files

datas = collect_data_files("pixeltable_pgserver", include_py_files=False)

hiddenimports = ["pixeltable_pgserver"]
