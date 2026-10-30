/** 本地文件 → base64（不带 data: 前缀）；上传到 `/api/career/*` 的 JSON 接口用。 */
export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(reader.error ?? new Error(`读取文件失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}
