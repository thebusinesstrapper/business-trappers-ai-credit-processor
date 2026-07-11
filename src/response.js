export function successResponse(data = {}) {
    return {
        success: true,
        milestone: "M1_CLIENT_ACCESS",
        timestamp: new Date().toISOString(),
        ...data
    };
}

export function errorResponse(errorCode, errorMessage) {
    return {
        success: false,
        milestone: "M1_CLIENT_ACCESS",
        error_code: errorCode,
        error_message: errorMessage,
        timestamp: new Date().toISOString()
    };
}
