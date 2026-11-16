# terminal-messenger

**Đọc và trả lời Facebook Messenger ngay trong terminal.**

[English](README.md) · [Tiếng Việt](README.vi.md)

`terminal-messenger` gồm một ứng dụng terminal Node.js và một tiện ích mở rộng (extension) Chrome. Extension chạy trong tab Messenger mà chính bạn đã mở và đăng nhập, rồi chuyển tiếp nội dung về terminal trên cùng máy. Bạn xem danh sách chat, đọc tin, trả lời, thả cảm xúc và tải thêm tin cũ bằng cách gõ lệnh, không cần nhìn giao diện Facebook.

> **Không liên kết với Meta hay Facebook.** Đây là công cụ không chính thức. Nó không phải API Messenger chính thức và, nói chặt chẽ, vi phạm điều khoản sử dụng của Facebook. Xem [Tuyên bố miễn trừ](#tuyên-bố-miễn-trừ).

## Mục lục

- [Tính năng](#tính-năng)
- [Cách hoạt động](#cách-hoạt-động)
- [Yêu cầu](#yêu-cầu)
- [Bắt đầu nhanh](#bắt-đầu-nhanh)
- [Cách dùng](#cách-dùng)
- [An toàn và quyền riêng tư](#an-toàn-và-quyền-riêng-tư)
- [Giới hạn](#giới-hạn)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Phát triển](#phát-triển)
- [Tuyên bố miễn trừ](#tuyên-bố-miễn-trừ)
- [Giấy phép](#giấy-phép)

## Tính năng

- Xem danh sách chat và mở một chat (`/list`, `/open`).
- Đọc các tin gần đây, mỗi tin có một số để bạn nhắc tới.
- Trả lời bằng cách gõ một dòng, hoặc trả lời trích dẫn một tin cụ thể (`/reply`).
- Thả cảm xúc lên tin mới nhất của người kia, hoặc lên một tin gần đây bất kỳ (`/react`).
- Tải thêm tin cũ khi cần; cả cuộc trò chuyện được vẽ lại từ cũ đến mới (`/more`).
- Tin mới đến ngay lập tức và kêu chuông terminal.
- Có trợ giúp tích hợp (`/help`) và lệnh xóa màn hình (`/clear`).
- Không phụ thuộc tiếng Anh: danh sách chat, danh sách tin, nút bấm và cảm xúc được nhận ra theo cấu trúc trang, vị trí và emoji, không theo chữ (đã bị dịch). Đã thử với giao diện Facebook tiếng Việt.

## Cách hoạt động

```
 bạn gõ              ┌──────────────┐  127.0.0.1:8765   ┌───────────────────┐   ┌────────────────┐
 trong terminal ───▶ │ ứng dụng     │ ◀───────────────▶ │ extension Chrome  │──▶│ tab Messenger  │
 (Node.js)           │ terminal     │   WebSocket,      │ (extension/)      │   │ (bạn tự đăng   │
                     └──────────────┘   có mã ghép đôi  └───────────────────┘   │ nhập)          │
                                                                                 └────────────────┘
```

1. Ứng dụng terminal chỉ lắng nghe trên `127.0.0.1` và nhận một kết nối, kết nối này phải xuất trình mã ghép đôi (token) ngẫu nhiên.
2. Extension kết nối tới đó từ service worker và chuyển lệnh cho content script chạy trong tab Messenger của bạn.
3. Content script đọc trang, và khi trả lời thì gõ vào ô soạn tin thật và bấm nút gửi thật, y như bạn làm.

Không có gì đăng nhập Facebook thay bạn, không đọc mật khẩu hay cookie, và extension không tự gửi yêu cầu nào tới Facebook.

## Yêu cầu

- macOS, Linux hoặc Windows với **Node.js 20 trở lên**
- **Google Chrome** (hoặc trình duyệt Chromium khác) 116 trở lên
- Một tài khoản Facebook đã đăng nhập sẵn trong trình duyệt đó

## Bắt đầu nhanh

1. **Cài đặt** thư viện:
   ```sh
   git clone https://github.com/huynhson0809/terminal-messenger.git
   cd terminal-messenger
   npm install
   ```
2. **Chạy ứng dụng.**
   ```sh
   npm start
   ```
   Lần chạy đầu nó in ra mã ghép đôi (`Pairing token: ...`). Mã được lưu ở `~/.terminal-messenger/token` và dùng lại lần sau.
3. **Nạp extension.** Trong Chrome mở `chrome://extensions`, bật **Developer mode**, bấm **Load unpacked** và chọn thư mục `extension/`.
4. **Ghép đôi.** Bấm icon extension, dán mã vào cửa sổ nhỏ rồi bấm **Save**. Cửa sổ nhỏ hiện *connected* và terminal in `extension connected`.
5. **Mở Messenger.** Vào `https://www.facebook.com/messages/` và để tab đó là tab đang chọn trong một cửa sổ Chrome riêng. Nếu tab đã mở từ trước khi bạn nạp extension thì hãy tải lại (F5): Chrome không thêm extension vào các tab đã mở từ trước.

Hãy để cửa sổ đó **hiển thị trên màn hình**, dù nhỏ hay ở góc (màn hình thứ hai cũng được). Chrome tạm dừng các trang ở cửa sổ bị thu nhỏ hoặc bị che kín, và việc gửi từ đó có thể thất bại. Xem [Giới hạn](#giới-hạn).

Sau đó, trong terminal:

```
> /list
  1. Alice - hẹn 5 giờ nhé
● 2. Nhóm học - Bob: có ai làm chưa?
> /open 1
-- Alice --
[1] Alice: hẹn 5 giờ nhé?
[2] you: ok, chỗ cũ
> được đó
sent: "được đó"
```

Hãy thử trên chat với chính bạn hoặc một người bạn đã đồng ý trước khi dùng thật.

## Cách dùng

Mỗi dòng bạn gõ là một lệnh (bắt đầu bằng `/`) hoặc một tin nhắn.

| Lệnh | Tác dụng |
|---|---|
| `/list` | Hiện danh sách chat có đánh số. Chat chưa đọc có `●` ở đầu và được in đậm. |
| `/open <n>` | Mở chat số `n` và in các tin gần đây. Mỗi tin có `[số]`. |
| *chữ bất kỳ* | Gửi thành tin nhắn trong chat đang mở. |
| `//chữ` | Gửi tin bắt đầu bằng dấu gạch chéo (gửi `/chữ`). |
| `/reply <số tin> <nội dung>` | Trả lời trích dẫn tin `[số tin]`. |
| `/react <1-6> [số tin]` | Thả cảm xúc lên tin mới nhất của người kia, hoặc lên tin `[số tin]`. `1` thích, `2` yêu thích, `3` haha, `4` wow, `5` buồn, `6` phẫn nộ. |
| `/more` | Tải thêm tin cũ và vẽ lại chat: tin cũ ở trên cùng, tin mới nhất ở cuối. Gõ lại để đi xa hơn. |
| `/back` | Đóng chat đang mở. |
| `/clear` | Xóa màn hình và phần cuộn của nó. |
| `/help` (hoặc `/?`) | In danh sách lệnh. |
| `/quit` | Thoát. |

### Những điều nên biết

- Sau `/open`, hãy kiểm tra dòng `-- Tên --` có khớp chat bạn đã chọn không. Việc trả lời bị từ chối (`still opening ...`) cho tới khi dòng tiêu đề và các tin đã về đủ.
- Mỗi tin gửi đi được xác nhận kèm vài chữ đầu: `sent: "..."`, hoặc `not sent: "...": lý do`. Nếu thấy `no confirmation for "..."`, hãy `/open <n>` để kiểm tra tin đã đi chưa **trước khi** gõ lại, kẻo bị gửi hai lần.
- Trước khi làm gì với một tin có số (`/react`, `/reply`), extension kiểm tra tin ở vị trí đó vẫn bắt đầu bằng đúng chữ bạn đã thấy. Nếu có tin mới hay tin cũ làm lệch, nó từ chối thay vì đoán; hãy `/open` lại.
- `/react` và `/reply` chỉ với tới vài tin mới nhất (cỡ một màn hình), vì Facebook chỉ giữ các tin đang hiển thị trên trang.
- Chỉ dán một dòng mỗi lần. Dán nhiều dòng bị từ chối để nội dung vô tình trong clipboard không bị gửi đi thành nhiều tin.
- Tin mới làm terminal kêu chuông. Trong chat đang mở nó được in ra ngay; ở chat khác nó hiện dạng `[new] Tên: ...`.

## An toàn và quyền riêng tư

- **Chỉ trên máy bạn.** Ứng dụng chỉ lắng nghe `127.0.0.1:8765`; extension chỉ được phép kết nối tới địa chỉ đó (ép bằng chính sách bảo mật nội dung của nó). Không có gì được gửi tới máy chủ của tôi hay của ai khác.
- **Có mã bảo vệ.** Kết nối phải xuất trình mã ghép đôi ngẫu nhiên 256 bit ngay ở tin đầu tiên. File mã được tạo với quyền `0600`.
- **Không đụng tới thông tin đăng nhập.** Không đọc, lưu hay ghi log mật khẩu, cookie hoặc token phiên. Quyền của extension chỉ gồm `storage` và truy cập `facebook.com/messages` cùng `messenger.com`.
- **Gửi có chủ đích.** Không có gì được gửi cho tới khi bạn nhấn Enter trên một dòng. Các tin cách nhau ít nhất một giây, và một lần gửi không bao giờ tự thử lại.
- **Chống gửi nhầm chat.** Việc gửi bị từ chối nếu chat đang mở trong tab Facebook không phải chat bạn đã gõ vào, hoặc nếu ô soạn tin đang có sẵn chữ nháp. Chữ đã gõ được kiểm tra khớp với nội dung của bạn trước khi bấm nút gửi.
- **Văn bản từ người khác được làm sạch.** Tin của người khác bị loại bỏ các ký tự điều khiển terminal trước khi in.

Một lưu ý: mã chứng minh extension với ứng dụng, chứ không chứng minh chiều ngược lại. Nếu một chương trình khác trên cùng máy chiếm cổng 8765 khi ứng dụng không chạy, nó có thể đọc chat và gửi tin thay bạn. Hãy để ứng dụng chạy bất cứ khi nào extension còn lưu mã, hoặc bấm **Clear token** trong cửa sổ nhỏ khi không dùng.

Lấy lại hoặc đổi mã: `cat ~/.terminal-messenger/token`, hoặc xóa file đó rồi chạy lại `npm start` và dán mã mới vào cửa sổ nhỏ.

## Giới hạn

- **Cửa sổ Messenger phải luôn mở và hiển thị** (dù chỉ một góc nhỏ). Chrome tạm dừng cửa sổ bị thu nhỏ, ở desktop khác hoặc bị che kín. Việc gửi từ đó có thể thất bại (thất bại an toàn, không gửi gì), và tin mới có thể không hiện cho tới khi cửa sổ hiển thị lại.
- **Facebook hay đổi giao diện.** Khi đó việc đọc hoặc gửi có thể hỏng cho tới khi sửa các selector trong đối tượng `SELECTORS` ở đầu [`extension/content.js`](extension/content.js). Đó là nơi duy nhất cần sửa. Hoan nghênh issue và pull request.
- Chat mã hóa đầu cuối chỉ dùng được nếu đã được mở khóa sẵn trong tab trình duyệt.
- Chỉ văn bản. Ảnh, sticker và video hiện dạng `[image]`...; tệp đính kèm không có ảnh, video hoặc âm thanh xem trước có thể không báo.
- `/react` và `/reply` chỉ với tới vài tin mới nhất.
- Mạng và thiết bị của công ty hay trường có thể vẫn ghi lại các kết nối của bạn tới Facebook.

## Xử lý sự cố

| Bạn thấy | Ý nghĩa và cách xử lý |
|---|---|
| `extension not connected, open the Messenger tab` | Extension chưa kết nối. Kiểm tra ứng dụng đang chạy, extension đã nạp, mã trong cửa sổ nhỏ đúng, và cửa sổ nhỏ hiện *connected*. |
| `Messenger tab not ready, reload it` | Tab đã mở từ trước khi có extension. Tải lại (F5). |
| `can't read the page, Facebook layout may have changed` | Facebook đã đổi trang. Cập nhật selector trong `extension/content.js` (xem [Phát triển](#phát-triển)). |
| `conversation still loading; not sent` | Bạn trả lời ngay sau `/open`. Đợi khoảng 3 giây rồi thử lại. |
| `the message box in the Messenger tab is not empty; not sent` | Ô soạn tin đang có chữ nháp. Xóa nó trong tab. |
| `couldn't type the message correctly; not sent` | Chữ không vào được ô soạn tin. Hãy chắc cửa sổ đang hiển thị rồi thử lại. Phần `[debug: ...]` giúp ích khi báo lỗi. |
| `couldn't find the send button; not sent` | Không nhận ra nút gửi. Xóa chữ nháp trong tab và báo lỗi. |
| `no confirmation for "..."` | Ứng dụng không nhận được phản hồi. Hãy `/open <n>` để kiểm tra tin đã đi chưa rồi mới gửi lại. |
| `that message isn't where it was ... run /open again` | Tin mới hoặc tin cũ làm lệch số. Hãy `/open` lại. |
| `that message is further back than the Messenger tab keeps on screen` | `/react` và `/reply` chỉ với tới vài tin mới nhất. |
| `port 8765 is in use` | Có bản khác của ứng dụng (hoặc chương trình khác) đang dùng cổng này. |

## Phát triển

```sh
npm test      # chạy toàn bộ bộ test (node:test, không cần thư viện thêm)
```

Cấu trúc dự án:

```
src/          ứng dụng terminal: lệnh, hiển thị, cầu nối cục bộ, hàng đợi gửi
extension/    extension Chrome (Manifest V3): service worker, content script, page shim, popup
test/         test cho cả hai phía
docs/         bản thiết kế và kế hoạch triển khai ban đầu
```

- Giao thức giữa hai phía: JSON qua WebSocket cục bộ. Terminal gửi extension: `list`, `open`, `send`, `reply`, `react`, `more`. Extension gửi terminal: `chats`, `messages`, `incoming`, `sent`, `reacted`, `error`.
- Mọi thứ phụ thuộc vào trang Facebook nằm trong `SELECTORS` ở đầu `extension/content.js`. Ưu tiên các móc ổn định (vai trò, cấu trúc `aria`, emoji) hơn tên lớp sinh tự động, và tránh so khớp theo chữ vì Facebook dịch chúng.
- Logic thuần của extension nằm ở `extension/lib.js` và có unit test; chuỗi bước an toàn khi gửi (`performSend`) được test với một trang giả.

## Tuyên bố miễn trừ

Dự án được cung cấp nguyên trạng, không kèm bảo hành. Nó **không** liên kết, không được tài trợ và không có quan hệ với Meta Platforms, Inc. "Facebook" và "Messenger" là nhãn hiệu của chủ sở hữu. Tự động hóa tài khoản Facebook là vi phạm điều khoản sử dụng của Facebook và có thể dẫn đến việc tài khoản bị hạn chế. Bạn tự chịu rủi ro khi dùng và tự chịu trách nhiệm tuân thủ các điều khoản và quy định áp dụng cho bạn, kể cả của công ty hay trường học.

## Giấy phép

[MIT](LICENSE)
