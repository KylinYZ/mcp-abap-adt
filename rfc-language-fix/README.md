# RFC 中文语言键修复

## 应用补丁

在各自仓库根目录执行：

```powershell
git apply D:\MyDev\SAP\mcp-abap-abap-adt-api\rfc-language-fix\open-rfc-go-language.patch
git apply D:\MyDev\SAP\mcp-abap-abap-adt-api\rfc-language-fix\vsp-language.patch
```

## 验证

```powershell
go test ./...   # open-rfc-go
go test ./pkg/saprfc ./internal/mcp   # vibing-steampunk
go build -o vsp-language-fixed.exe ./cmd/vsp   # vibing-steampunk
```

已验证：

- `SAP_LANGUAGE=ZH` 时，RFC `info` 成功。
- `BAPI_COMPANYCODE_GETDETAIL` 的元数据在 `ZH` 下返回中文描述，在 `EN` 下返回英文描述。
