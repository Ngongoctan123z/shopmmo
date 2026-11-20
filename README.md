# ShopMMO

ShopMMO dùng JavaScript trên Node.js 24 và SQLite tích hợp, không cần cài gói npm. Trang khách đọc danh mục qua API cùng origin. Trang quản trị ở /admin.

## Chạy

Sao chép .env.example thành .env, cấu hình các biến bên dưới, rồi chạy:

    node --env-file=.env server.mjs

Mặc định ứng dụng nghe trên http://127.0.0.1:8787. Chạy sau reverse proxy HTTPS khi đưa lên môi trường công khai. Giữ HOST là 127.0.0.1 nếu proxy chạy cùng máy. Đặt SHOPMMO_DB trỏ tới tệp trên ổ lưu trữ bền vững và triển khai một tiến trình Node cho mỗi cơ sở dữ liệu.

- ADMIN_TOKEN là chuỗi ngẫu nhiên từ 32 ký tự trở lên. Có thể tạo bằng node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))".
- MELODY_API_KEY và MELODY_API_SECRET cần quyền products.list.
- UNIZ_API_KEY tùy chọn đối với endpoint danh mục công khai. Nếu cấu hình, ứng dụng gửi qua header x-api-key.
- PORT, HOST và SHOPMMO_DB có thể ghi đè mặc định.
- Tệp .env và SQLite vận hành nằm ngoài Git và gói phát hành.

## Quản lý danh mục

1. Mở /admin và nhập ADMIN_TOKEN. Trình duyệt chỉ giữ mã trong bộ nhớ của tab.
2. Xem trạng thái và lần cập nhật của từng API. Đồng bộ định kỳ mỗi 5 phút hoặc nhấn Đồng bộ ngay.
3. Lọc gói chờ duyệt, đang hiển thị, bị chặn hoặc hết hàng. Kiểm tra từng SKU với nhà cung cấp. Thương hiệu được gắn theo gói nguồn. Nhập giá bán nếu muốn mở checkout. Giá bán phải được nhập riêng cho MelodyApp để không công bố giá CTV.
4. Xác nhận điều kiện giao ngay của gói rồi đăng. Có thể cập nhật giá hoặc ẩn gói. Màn hình quản trị có nhật ký cho các thao tác đồng bộ và đổi trạng thái.

Danh mục Uniz giới hạn hai SKU đã chọn, CapCut Pro Cá Nhân 1 Tháng và Admin Canva Pro Business 100 Slot 1 Tháng. Vì API Uniz chỉ trả inStock, mỗi lần đồng bộ backend đối chiếu tiêu đề SKU và nhãn Có ngay trên trang sản phẩm. Kiểm tra thất bại sẽ ẩn gói.

MelodyApp được giới hạn trong nhóm làm đẹp và FPT Play. Gói đăng bán yêu cầu is_instant, in_stock, stock_count dương và không có trường nhập bổ sung. Danh sách mở đầu gồm các gói sẵn của Meitu, Hypic và Wink. Giữ gói FPT Play 809 trong admin vì mô tả yêu cầu số điện thoại và chờ kích hoạt. Xingtu yêu cầu OTP do shop cung cấp nên bị chặn.

Các gói đã chọn được đăng lần đầu với giá niêm yết tham khảo từ nguồn. Admin đặt giá bán riêng trước checkout. Đồng bộ không ghi đè gói đã ẩn hoặc giá đã đặt. Dữ liệu quá 20 phút, SKU mất khỏi nguồn hoặc gói đổi thông tin sẽ tự ẩn.

Khi triển khai công khai, đặt khóa nhà cung cấp bằng secret của máy chủ và hạn chế IP truy cập /admin và /api/admin/ nếu reverse proxy hỗ trợ.

## Nguồn

- https://melodyapp.vn/document-api
- https://unizvn.com/api-docs


## Thanh toán VietQR qua GPM Pay

- Sử dụng tài khoản nhận tiền mà bạn sở hữu hoặc được ủy quyền. Điền mã BIN NAPAS 6 chữ số, số tài khoản và tên chủ tài khoản vào các biến GPMPAY_BANK_BIN, GPMPAY_ACCOUNT_NUMBER và GPMPAY_ACCOUNT_NAME.
- Trên GPM Pay, thêm webhook HTTPS mới cho ShopMMO tại /api/payments/gpmpay, chọn HMAC và cấu hình cùng một secret ngẫu nhiên dài ít nhất 32 ký tự trong GPMPAY_WEBHOOK_SECRET. Giữ nguyên webhook của VNDocs nếu đang dùng chung tài khoản.
- DELIVERY_KEY là 32 byte ngẫu nhiên biểu diễn bằng đúng 64 ký tự hex. Sao lưu khóa riêng vì nó dùng để mã hóa tài khoản đã giao. Tạo khóa bằng node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))".
- Bật MELODY_ORDER_ENABLED hoặc UNIZ_ORDER_ENABLED riêng theo nhà cung cấp khi đã xác nhận quyền tạo đơn, số dư ví và đối soát. MelodyApp cần quyền orders.create. Đặt giá bán từng SKU trong admin, tối thiểu 2.000 đ và không thấp hơn giá vốn API.
- Một đơn mua một gói và có mã chuyển khoản riêng. Hệ thống chỉ xử lý cho tiền vào thật, đúng tài khoản, số tiền, mã đơn và thời hạn 30 phút. Webhook giả lập được bỏ qua. Xem các đơn lệch tiền hay lỗi nhập hàng trong bảng Đơn hàng ShopMMO. Các trường hợp nhập hàng chưa rõ kết quả cần kiểm tra bên nguồn trước khi xử lý lại. Trạng thái đối soát không tự hoàn tiền.
- Khách mở mục Đơn hàng trên trình duyệt đã đặt để theo dõi và nhận nội dung. Trình duyệt lưu mã truy cập đơn. Không chia sẻ trình duyệt dùng để nhận đơn trên máy công cộng.
- Chạy kiểm thử không giao dịch thật bằng node checkout.test.mjs.

Tài liệu: https://docs.gpmpay.com/webhook và https://docs.gpmpay.com/

## Nhập hàng và đối soát nguồn

- Nút mua chỉ mở nếu nguồn được bật, số dư vừa được xác nhận và đủ giá vốn. Kiểm tra ví trong mục Kết nối API của admin. MelodyApp xác minh quyền qua account.info. Uniz xác thực khóa qua balance, phản hồi đó không cho biết quyền tạo đơn.
- Sau thanh toán, mỗi nguồn xử lý từng đơn một. Trước POST, backend kiểm tra lại SKU, tồn kho, giá vốn và ví. Nếu đã chuẩn bị gửi POST rồi mất phản hồi, đơn chuyển sang đối soát. Backend không tự gửi lại lệnh mua.
- Nếu nhà cung cấp đã trả mã đơn, nút Đối soát nguồn dùng GET và kiểm tra mã đơn cùng SKU trước khi giao cho khách. MelodyApp dùng orders.status. Endpoint GET được Uniz mô tả trả HTTP 405 trong lần kiểm tra trực tiếp, nên còn cần nhà cung cấp xác nhận đường dẫn hoặc đối soát thủ công.
- Kiểm thử tích hợp bằng node checkout.test.mjs dùng phản hồi giả cho cả hai nhà cung cấp. Có thể kiểm tra xác thực kết nối bằng nút Kiểm tra ví nguồn. POST đơn test lên nguồn thật chỉ dùng mã không tồn tại và số lượng 0. Kết quả từ chối xác nhận đường gọi và kiểm tra dữ liệu, không chứng minh định dạng giao hàng thành công.
