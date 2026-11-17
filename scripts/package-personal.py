"""Create a local-only personal bundle with a consistent SQLite snapshot.

Never upload this output: it contains documents and Windows-encrypted credentials.
The executable itself is built separately from application source only.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']


def main():
    built = ROOT / 'release' / 'win-unpacked'
    if not (built / 'PaperDesk.exe').is_file():
        raise RuntimeError('Run electron-builder --win --x64 --dir first')
    original_profile = Path(os.environ['APPDATA']) / 'paperdesk'
    original_data = Path(os.environ.get('PAPERDESK_DATA') or original_profile / 'data')
    if not (original_data / 'library.sqlite').is_file():
        raise RuntimeError('Personal library not found; refusing to create an empty personal bundle')
    private_root = ROOT / 'release' / 'private'
    private_root.mkdir(parents=True, exist_ok=True)
    destination = private_root / f'PaperDesk-v{VERSION}-personal-win-x64'
    # Never overwrite a prior private snapshot.
    if destination.exists():
        from datetime import datetime
        destination = destination.with_name(destination.name + '-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    destination.mkdir()
    shutil.copytree(built, destination / 'app', ignore=shutil.ignore_patterns(
        'debug.log', 'PaperDesk-probe.exe', 'electron.exe'))
    if os.name == 'nt':
        app_dir = (destination / 'app').resolve()
        if not app_dir.is_relative_to(private_root.resolve()):
            raise RuntimeError('Unexpected personal application directory')
        subprocess.run(['icacls.exe', str(app_dir), '/setintegritylevel', '(OI)(CI)M', '/T', '/C'],
                       check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    shutil.copytree(original_data, destination / 'data', ignore=shutil.ignore_patterns(
        'library.sqlite', 'library.sqlite-wal', 'library.sqlite-shm', '*.log', '__pycache__'))
    with sqlite3.connect((original_data / 'library.sqlite').as_uri() + '?mode=ro', uri=True) as src:
        with sqlite3.connect(destination / 'data' / 'library.sqlite') as dst:
            src.backup(dst)
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Snapshot integrity check failed')
            counts = {name: dst.execute(f'SELECT COUNT(*) FROM {name}').fetchone()[0]
                      for name in ('items', 'attachments', 'library_groups')}
    profile = destination / 'profile'
    profile.mkdir()
    for name in ('Local State', 'Preferences'):
        if (original_profile / name).is_file():
            shutil.copy2(original_profile / name, profile / name)
    # The runtime on this machine is intentionally reused, rather than copying Conda.
    launcher = (
        '@echo off\r\nsetlocal\r\n'
        'set "PAPERDESK_DATA=%~dp0data"\r\n'
        f'set "PAPERDESK_PYTHON={sys.executable}"\r\n'
        'set "ELECTRON_RUN_AS_NODE="\r\n'
        'set "ELECTRON_RENDERER_URL="\r\n'
        'start "" "%~dp0app\\PaperDesk.exe" --user-data-dir="%~dp0profile"\r\n'
    )
    (destination / 'Start-PaperDesk.cmd').write_bytes(launcher.encode('utf-8'))
    note = f'''PaperDesk v{VERSION} 自用版

请先完整解压，再双击 Start-PaperDesk.cmd。
此版本使用本目录 data 中的文库快照，原文库保持原样；以后新增的数据也保存在这里。
快照包含 {counts['items']} 篇论文、{counts['attachments']} 份附件、{counts['library_groups']} 个分组。
API Key 保留现有设置；模型密钥保留加密值，只能在原 Windows 用户账户下继续使用。
此文件夹和 ZIP 含个人论文、笔记及配置，仅供本机自用，不要上传 GitHub 或发给别人。
本机 Python：{sys.executable}
移动到其他电脑时需另行安装 Python 依赖并重新配置 API Key。

app 中的程序文件不含文库；data 是本次复制的个人数据；profile 是自用窗口配置。
若要继续使用此前 %APPDATA%\\paperdesk\\data 中的实时文库，可直接运行 app\\PaperDesk.exe。
两种启动方式使用不同的数据位置，请选定一种后持续使用。
'''
    (destination / '使用说明.txt').write_text(note, encoding='utf-8-sig')
    (destination / 'manifest.json').write_text(json.dumps({
        'version': VERSION, 'private': True, 'counts': counts,
        'credentialStorage': 'original settings preserved; model keys encrypted; same Windows user required',
        'dataLocation': 'data', 'pythonRuntime': sys.executable
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    archive = destination.parent / (destination.name + '.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=3) as bundle:
        for file in destination.rglob('*'):
            if file.is_file():
                bundle.write(file, file.relative_to(destination.parent))
    checksum = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    archive.with_suffix('.zip.sha256').write_text(checksum + '  ' + archive.name + '\n', encoding='ascii')
    print(json.dumps({'folder': str(destination), 'archive': str(archive), 'counts': counts,
                      'sizeMB': round(archive.stat().st_size / 1024**2), 'sha256': checksum}, ensure_ascii=False))


if __name__ == '__main__':
    main()
