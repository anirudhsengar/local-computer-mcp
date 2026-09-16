#!/usr/bin/env python3
"""Validate and extract zip/tar archives without traversal or symlinks."""
import os
import pathlib
import shutil
import sys
import tarfile
import tempfile
import zipfile

source, destination = map(pathlib.Path, sys.argv[1:3])

def safe_name(name):
    value = pathlib.PurePosixPath(name.replace("\\", "/"))
    if value.is_absolute() or ".." in value.parts:
        raise ValueError(f"unsafe archive path: {name}")
    return value

destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists():
    raise FileExistsError(destination)

with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".extract-") as tmp:
    root = pathlib.Path(tmp)
    if zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            for member in archive.infolist():
                safe_name(member.filename)
                mode = member.external_attr >> 16
                if mode and (mode & 0o170000) == 0o120000:
                    raise ValueError(f"archive symlink denied: {member.filename}")
            archive.extractall(root)
    elif tarfile.is_tarfile(source):
        with tarfile.open(source) as archive:
            for member in archive.getmembers():
                safe_name(member.name)
                if member.issym() or member.islnk() or member.isdev():
                    raise ValueError(f"archive link/device denied: {member.name}")
            archive.extractall(root, filter="data")
    else:
        raise ValueError("unsupported archive; use zip or tar")
    os.replace(root, destination)
