"""Install reviewed Linux x86_64 CI tools, checking the pinned archive checksum."""
import argparse
import hashlib
import io
import json
import platform
import tarfile
import urllib.request
from pathlib import Path


def main():
    manifest = Path(__file__).resolve().parent.parent / "security" / "tools.json"
    tools = json.loads(manifest.read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tools", nargs="+", choices=tools, required=True)
    parser.add_argument("--bin-dir", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
        raise SystemExit("The pinned CI tool archives require Linux x86_64.")
    args.bin_dir.mkdir(parents=True, exist_ok=True)
    for name in args.tools:
        tool = tools[name]
        print(f"Installing {name} {tool['version']}", flush=True)
        request = urllib.request.Request(tool["url"], headers={"User-Agent": "WorkSphere-CI"})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != tool["sha256"]:
            raise SystemExit(f"Checksum verification failed for {name}.")
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            candidates = [member for member in archive.getmembers()
                          if member.isfile() and Path(member.name).name == name]
            if len(candidates) != 1:
                raise SystemExit(f"Expected one executable named {name} in the archive.")
            with archive.extractfile(candidates[0]) as executable:
                destination = args.bin_dir / name
                destination.write_bytes(executable.read())
        destination.chmod(0o755)


if __name__ == "__main__":
    main()
