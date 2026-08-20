# Lazy 握手移植审查：参考实现 ≠ 协议最优形态（2026-08-13 私有项目 H PR#38 实证）

- **案例**：私有项目 H PR#38 把 hysteria2 TCP 握手延迟到首次读写，声称"matches sing-quic's lazy handshake"。查证：sing-quic `clientConn.Read` 同样直接读响应、不驱动请求发送——两者同款 server-first 死锁（客户端先读时请求未发出，服务器等请求不响应）。而官方 hysteria 客户端（apernet/hysteria）FastOpen 是 **dial 时立即 WriteTCPRequest、只推迟读响应**——请求先出门，无死锁
- **教训**：审查"对标参考实现 X"的移植类改动时，必须同时对照**协议官方实现**验证 X 本身是否次优。参考实现忠实复刻 ≠ 正确，可能把参考实现的缺陷一起移植
- **死锁判定链**（可复用）：请求发送是否延迟到写路径 → 读路径是否驱动请求 → 上层 relay 是否只在客户端有数据时轮询写方向（tokio copy_buf 语义）→ relay 有无空闲超时。四环节全中才成立
- **server-first 协议集合**：SMTP/FTP/IMAP/POP3 banner 等；SSH/RDP 是 client-first（客户端先发版本串/X.224），审查时别误举例
