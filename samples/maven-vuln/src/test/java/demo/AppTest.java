package demo;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class AppTest {
    @Test
    public void labelsTrimAndCapitalize() {
        assertEquals("Hello", App.label(" hello "));
    }

    @Test
    public void blankInputIsEmpty() {
        assertEquals("empty", App.label("   "));
    }
}
