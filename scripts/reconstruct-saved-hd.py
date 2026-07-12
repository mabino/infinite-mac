#!/usr/bin/env python3
import os
import sys
import json
import zipfile
import urllib.request

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 reconstruct-saved-hd.py <path_to_infinitemacdisk> <output_dsk_path>")
        sys.exit(1)

    infinitemacdisk_path = sys.argv[1]
    output_dsk_path = sys.argv[2]

    # Resolve paths relative to project root
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    manifest_path = os.path.join(root_dir, "src", "Data", "Saved HD.dsk.json")
    build_dir = os.path.join(root_dir, "Images", "build")

    if not os.path.exists(manifest_path):
        print(f"Error: Manifest not found at {manifest_path}")
        sys.exit(1)

    with open(manifest_path, "r") as f:
        manifest = json.load(f)

    total_size = manifest["totalSize"]
    chunk_size = 256 * 1024
    chunks = manifest["chunks"]

    print(f"Loading backup zip from {infinitemacdisk_path}...")
    with zipfile.ZipFile(infinitemacdisk_path, "r") as zip_ref:
        dirty_chunks_data = zip_ref.read("Saved HD.dirtychunks")
        modified_data = zip_ref.read("Saved HD.data")

    print(f"Modified data size: {len(modified_data)} bytes")
    print(f"Target disk size: {total_size} bytes")

    # Initialize the output disk image with the modified data
    image = bytearray(modified_data)
    if len(image) < total_size:
        image.extend(b"\0" * (total_size - len(image)))

    print("Reconstructing clean chunks from base image...")
    for chunk_index, signature in enumerate(chunks):
        if not signature:
            # Zero chunk, leave as is
            continue

        chunk_byte = chunk_index >> 3
        chunk_bit = 1 << (chunk_index & 7)

        # If the bit is set, it means the chunk is dirty (modified). Keep the modified data.
        # If the bit is NOT set, use the base chunk.
        if chunk_byte < len(dirty_chunks_data):
            is_dirty = (dirty_chunks_data[chunk_byte] & chunk_bit) != 0
        else:
            is_dirty = False

        if not is_dirty:
            # Try to read local chunk first
            chunk_file_path = os.path.join(build_dir, f"{signature}.chunk")
            chunk_data = None
            if os.path.exists(chunk_file_path):
                with open(chunk_file_path, "rb") as cf:
                    chunk_data = cf.read()
            else:
                # Fetch from remote repository if not found locally
                url = f"https://infinitemac.org/Disk/{signature}.chunk"
                try:
                    with urllib.request.urlopen(url, timeout=15) as response:
                        chunk_data = response.read()
                except Exception as e:
                    print(f"Warning: Failed to fetch remote chunk {signature}: {e}")

            if chunk_data:
                offset = chunk_index * chunk_size
                image[offset:offset + len(chunk_data)] = chunk_data

    print(f"Writing reconstructed raw disk image to {output_dsk_path}...")
    with open(output_dsk_path, "wb") as f:
        f.write(image)

    print("\nSuccessfully reconstructed raw disk image!")
    print("On macOS, you can mount it natively by double-clicking it or running:")
    print(f"  hdiutil mount \"{output_dsk_path}\"")

if __name__ == "__main__":
    main()
