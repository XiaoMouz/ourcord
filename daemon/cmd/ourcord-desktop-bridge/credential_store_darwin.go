//go:build darwin && cgo

package main

/*
#cgo CFLAGS: -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdlib.h>

static OSStatus ourcord_keychain_find(
  UInt32 serviceLen, const char *service,
  UInt32 accountLen, const char *account,
  UInt32 *passwordLen, void **passwordData,
  SecKeychainItemRef *item
) {
  return SecKeychainFindGenericPassword(
    NULL, serviceLen, service, accountLen, account,
    passwordLen, passwordData, item
  );
}

static OSStatus ourcord_keychain_add(
  UInt32 serviceLen, const char *service,
  UInt32 accountLen, const char *account,
  UInt32 passwordLen, const void *passwordData
) {
  return SecKeychainAddGenericPassword(
    NULL, serviceLen, service, accountLen, account,
    passwordLen, passwordData, NULL
  );
}

static OSStatus ourcord_keychain_update(
  SecKeychainItemRef item, UInt32 passwordLen, const void *passwordData
) {
  return SecKeychainItemModifyAttributesAndData(item, NULL, passwordLen, passwordData);
}

static OSStatus ourcord_keychain_free(void *passwordData) {
  return SecKeychainItemFreeContent(NULL, passwordData);
}
*/
import "C"

import (
	"fmt"
	"unsafe"

	"github.com/zalando/go-keyring"
)

type osCredentialStore struct{}

func macOSKeychainStatus(operation string, status C.OSStatus) error {
	if status == C.errSecSuccess {
		return nil
	}
	if status == C.errSecItemNotFound {
		return keyring.ErrNotFound
	}
	return fmt.Errorf("macOS keychain %s failed (%d)", operation, int32(status))
}

func keychainBytes(value string) (unsafe.Pointer, C.UInt32, func()) {
	data := C.CBytes([]byte(value))
	return data, C.UInt32(len(value)), func() { C.free(data) }
}

func (osCredentialStore) Get(service, user string) (string, error) {
	serviceData, serviceLen, freeService := keychainBytes(service)
	defer freeService()
	userData, userLen, freeUser := keychainBytes(user)
	defer freeUser()

	var passwordLen C.UInt32
	var passwordData unsafe.Pointer
	var item C.SecKeychainItemRef
	status := C.ourcord_keychain_find(
		serviceLen, (*C.char)(serviceData),
		userLen, (*C.char)(userData),
		&passwordLen, &passwordData, &item,
	)
	if err := macOSKeychainStatus("read", status); err != nil {
		return "", err
	}
	defer C.ourcord_keychain_free(passwordData)
	if item != C.SecKeychainItemRef(0) {
		defer C.CFRelease(C.CFTypeRef(item))
	}
	return string(C.GoBytes(passwordData, C.int(passwordLen))), nil
}

func (osCredentialStore) Set(service, user, password string) error {
	serviceData, serviceLen, freeService := keychainBytes(service)
	defer freeService()
	userData, userLen, freeUser := keychainBytes(user)
	defer freeUser()
	passwordData, passwordLen, freePassword := keychainBytes(password)
	defer freePassword()

	var item C.SecKeychainItemRef
	status := C.ourcord_keychain_find(
		serviceLen, (*C.char)(serviceData),
		userLen, (*C.char)(userData),
		nil, nil, &item,
	)
	if status == C.errSecSuccess {
		defer C.CFRelease(C.CFTypeRef(item))
		status = C.ourcord_keychain_update(item, passwordLen, passwordData)
		return macOSKeychainStatus("update", status)
	}
	if status != C.errSecItemNotFound {
		return macOSKeychainStatus("find", status)
	}
	status = C.ourcord_keychain_add(
		serviceLen, (*C.char)(serviceData),
		userLen, (*C.char)(userData),
		passwordLen, passwordData,
	)
	return macOSKeychainStatus("write", status)
}

func (osCredentialStore) Delete(service, user string) error {
	serviceData, serviceLen, freeService := keychainBytes(service)
	defer freeService()
	userData, userLen, freeUser := keychainBytes(user)
	defer freeUser()

	var item C.SecKeychainItemRef
	status := C.ourcord_keychain_find(
		serviceLen, (*C.char)(serviceData),
		userLen, (*C.char)(userData),
		nil, nil, &item,
	)
	if err := macOSKeychainStatus("find", status); err != nil {
		return err
	}
	defer C.CFRelease(C.CFTypeRef(item))
	return macOSKeychainStatus("delete", C.SecKeychainItemDelete(item))
}
