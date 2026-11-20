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
3. Lọc gói chờ duyệt, đang hiển thị, bị chặn hoặc hết hàng. Kiểm tra từng SKU với nhà cung cấp. Chọn thương hiệu và giá bán. Giá bán phải được nhập riêng cho MelodyApp để không công bố giá CTV.
4. Xác nhận đây là tài khoản không AI và giao ngay rồi đăng. Có thể cập nhật giá hoặc ẩn gói. Màn hình quản trị có nhật ký cho các thao tác đồng bộ và đổi trạng thái.

MelodyApp yêu cầu is_instant, in_stock và stock_count dương; gói cần nhập thông tin bị chặn. Uniz trả inStock nhưng không có trường chế độ giao hàng. Ba SKU Uniz ban đầu được chọn theo nhãn Có ngay trên trang công khai, những SKU khác cần admin kiểm tra. Gói bị chặn bởi dấu hiệu AI hoặc xử lý thủ công không thể đăng. Dữ liệu quá 20 phút, SKU mất khỏi nguồn hoặc gói đổi thông tin sẽ tự ẩn.

Tích hợp hiện tại chỉ gọi API đọc dữ liệu sản phẩm. Giao dịch diễn ra trên trang nhà cung cấp. Khi triển khai công khai, đặt khóa nhà cung cấp bằng secret của máy chủ và hạn chế IP truy cập /admin và /api/admin/ nếu reverse proxy hỗ trợ.

## Nguồn

- https://melodyapp.vn/document-api
- https://unizvn.com/api-docs
