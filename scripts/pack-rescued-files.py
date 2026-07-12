#!/usr/bin/env python3
import os
import sys

# Add scripts directory to path to import machfs
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import machfs

def copy_folder(src_folder, dst_folder):
    for name, item in src_folder.items():
        if isinstance(item, machfs.Folder):
            new_folder = machfs.Folder()
            dst_folder[name] = new_folder
            copy_folder(item, new_folder)
        else:
            new_file = machfs.File()
            new_file.data = item.data
            new_file.rsrc = item.rsrc
            new_file.type = item.type
            new_file.creator = item.creator
            new_file.flags = item.flags
            dst_folder[name] = new_file

def main():
    image_path = "/Users/mabino/Downloads/Saved HD.dsk"
    output_path = "/Users/mabino/Downloads/Rescued Files.dsk"

    if not os.path.exists(image_path):
        print(f"Error: Reconstructed disk not found at {image_path}")
        sys.exit(1)

    print("Reading old Saved HD.dsk...")
    with open(image_path, "rb") as f:
        old_data = f.read()

    old_vol = machfs.Volume()
    old_vol.read(old_data)

    print("Creating new compact volume...")
    new_vol = machfs.Volume()
    new_vol.name = "Rescued"

    # Copy files recursively from the old volume to the new volume
    copy_folder(old_vol, new_vol)

    print("Writing new compact volume (50MB)...")
    # 50MB = 50 * 1024 * 1024
    new_data = new_vol.write(size=50 * 1024 * 1024, align=512, desktopdb=False, bootable=False)

    with open(output_path, "wb") as f:
        f.write(new_data)

    print(f"\nSuccessfully packed rescued files into: {output_path}")
    print("This file is only 50MB and can be safely imported without causing memory errors.")

if __name__ == "__main__":
    main()
