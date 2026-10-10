# cld-guard

Plugin Claude Code cho repo **webmgo** (website & CMS MGO Remak® FireOFF). Plugin biến các quy tắc trong `CLAUDE.md` và "sổ đen" thành rào chắn tự động khi Claude làm việc trong repo.

Ở ngoài repo webmgo, plugin không làm gì. Repo được nhận ra khi `packages/shared/package.json` có tên `@remak/shared`.

> Dùng function hooks của Claude Code. Đã kiểm trên bản **2.1.296**. Đây là API early access, nên có thể phải sửa lại khi Claude Code đổi phiên bản.

## Tính năng

| Phần | Hook | Làm gì |
| --- | --- | --- |
| **code-guard** | `tool.call` Edit / Write | Chặn những đoạn code **mới thêm** vi phạm sổ đen (xem danh sách bên dưới). Vi phạm có sẵn từ trước thì không chặn. |
| **bash-guard** | `tool.call` Bash | Chặn lệnh phá dữ liệu hoặc sai quy ước (xem danh sách bên dưới). |
| **verify-status** | `tool.call` + `session.start` | Theo dõi package nào đã bị sửa mà chưa chạy lint/build/test, hiện trên status line, ví dụ `Chưa kiểm: api(lint,test) · fe(build)`. Chạy đúng lệnh `pnpm --filter … lint/build/test` thì mục tương ứng tự mất. |
| **prompt-context** | `prompt.submit` | Gắn một khối ngữ cảnh vào sau mỗi prompt bạn gõ (chi tiết bên dưới). Người dùng không thấy khối này, chỉ Claude đọc. |

**code-guard chặn:**
- import tương đối thiếu `.js` trong `api/`;
- `@prisma/client`;
- Prisma / `pg` / Redis trong `fe/`;
- `revalidateTag` chỉ có một tham số;
- `next/link` hoặc `<a href="/…">` ở web khách hàng;
- token lưu trong `localStorage`;
- `'\.'` trong `proxy.ts`;
- sửa hoặc xoá migration đã commit.

**bash-guard chặn:**
- `db:seed` toàn bộ;
- `npm` / `yarn`;
- `curl -d "$BIEN"`;
- `git reset --hard`, `git clean -f`, force push, push thẳng `dev` / `main`;
- `rm -r` ngoài thư mục build hoặc thư mục tạm;
- `prisma migrate reset`, `docker compose down -v`, câu SQL `DROP` / `TRUNCATE`.

**prompt-context gắn vào sau mỗi prompt:**
- nhánh hiện tại, nhắc base PR là `dev`, và `git status` rút gọn;
- các check chưa chạy;
- những dòng sổ đen thuộc khu vực liên quan (`fe`, `cms`, `api`, `db`, `infra`, `git`). Khu vực được đoán từ chữ trong prompt và từ các file đang sửa. Sổ đen được đọc thẳng từ `CLAUDE.md` của repo mỗi lần gắn.

Mod gắn ngữ cảnh vào sau prompt chứ không sửa system prompt. Lý do: system prompt đổi mỗi lượt thì prompt cache của cả hội thoại mất theo.

### Từ khoá ở đầu prompt

- `fix: <mô tả lỗi>`: Claude làm theo quy trình tái hiện → tìm nguyên nhân gốc → sửa kèm test → kiểm chứng → báo lại.
- `review: <phạm vi>`: Claude review theo checklist kiến trúc, độ ổn định, bảo mật, hiệu năng, quy ước và **toàn bộ** sổ đen, và không sửa file. Nếu không ghi phạm vi, Claude review phần thay đổi của nhánh so với `dev` cộng phần chưa commit.

### Khi thật sự cần chạy lệnh bị chặn

Phần lớn lệnh bị bash-guard chặn có thể chạy lại nếu thêm đuôi `# user-approved` ở cuối lệnh. Claude được dặn chỉ thêm đuôi này khi bạn đã đồng ý rõ ràng trong chat.

Riêng `npm` / `yarn` và `curl -d "$BIEN"` thì không vượt được.

## Cài đặt

**Cách 1: cài từ GitHub.** Khuyên dùng cho cả team. Gõ ở prompt của Claude Code trong terminal:

```
/plugin install cld-guard --marketplace <owner>/cld-guard
```

Trả lời `y` để thêm marketplace, rồi chọn scope (user). Thay `<owner>` bằng tài khoản hoặc org GitHub chứa repo này.

**Cách 2: chạy thẳng từ thư mục clone về.** Dùng khi đang phát triển plugin. Thêm vào phần `env` của `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "D:\\cld-guard"
  }
}
```

Khởi động lại Claude Code. Thư mục này được theo dõi, nên sửa file là plugin tự nạp lại.

## Phát triển

```bash
claude plugin validate .   # kiểm manifest + hooks như engine sẽ đọc
claude plugin test .       # chạy tests/*.test.ts
```

Cấu trúc thư mục:
- `hooks/register.ts`: mọi `on(...)` và các hàm gọi `$`. Validator yêu cầu hàm nhận `$` phải nằm cùng file với nơi dùng.
- `hooks/*-rules.ts`, `verify.ts`, `repo.ts`: logic thuần, được test trực tiếp.
- `types/index.d.ts`: khai báo state của plugin.

Khi sổ đen trong `CLAUDE.md` có dòng mới:
- prompt-context tự đọc được, không cần sửa gì;
- muốn code-guard / bash-guard **chặn** lỗi đó thì thêm luật vào `hooks/code-rules.ts` hoặc `hooks/bash-rules.ts`, kèm test.

Chưa có luật cho hai lỗi sau vì khó bắt bằng regex: `orderBy` thiếu cột unique, và gọi Redis không có `try/catch`.
