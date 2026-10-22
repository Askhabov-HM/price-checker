package ru.pricechecker.lamoda;
import org.junit.Test;
import static org.junit.Assert.*;
public class AddressPolicyTest {
    @Test public void serverRejectsCredentialedOrUnencryptedAddresses() {
        assertEquals("https://prices.example", AddressPolicy.server("https://prices.example/"));
        for (String value : new String[]{"http://prices.example", "https://user:secret@prices.example", "https://prices.example/path", "https://prices.example/?token=synthetic", "https://prices.example/#fragment"}) {
            assertThrows(IllegalArgumentException.class, () -> AddressPolicy.server(value));
        }
    }
    @Test public void collectorOnlyRunsOnTheExactLamodaHttpsOrigin() {
        assertTrue(AddressPolicy.lamoda("https://www.lamoda.ru/wishlist/"));
        assertTrue(AddressPolicy.lamoda("https://lamoda.ru/"));
        for (String value : new String[]{"http://lamoda.ru", "https://lamoda.ru.evil.example", "https://user@lamoda.ru", "file:///lamoda.ru", "https://lamoda.ru:444"}) assertFalse(AddressPolicy.lamoda(value));
    }
}
