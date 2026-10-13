package demo;

import org.apache.commons.lang3.StringUtils;

public final class App {
    private App() {
    }

    public static String label(String input) {
        if (StringUtils.isBlank(input)) {
            return "empty";
        }
        return StringUtils.capitalize(input.trim());
    }
}
